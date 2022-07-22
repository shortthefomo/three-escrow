'use strict'

const dotenv = require('dotenv')
const debug = require('debug')
const log = debug('escrow:main')

const app = require('express')()
const https = require('https')
const http = require('http')
const fs = require( 'fs')
const WebSocketServer = require('ws').Server
const PubSubManager = require('./pubsub.js')
const EscrowManager = require('./escrow.js')
const EscrowOpen = require('./escrow_open.js')
const User = require('./user.js')

const NodeCache = require('node-cache')
const myCache = new NodeCache({ stdTTL: 3600, checkescrowNotificationperiod: 600 })

const db = require('./db.js')

class service  {
	constructor() {
        let httpsServer = null
        let httpServer = null
        if (process.env.CERT != null) {
        log('using https: for webhead: ' + process.env.APP_PORT)
        const sslOptions = {
            cert: fs.readFileSync(__dirname + process.env.CERT, 'utf8'),
            key: fs.readFileSync(__dirname + process.env.KEY, 'utf8'),
            ca: [
                fs.readFileSync(__dirname + process.env.BUNDLE, 'utf8')
            ]
        }
        httpsServer = https.createServer(sslOptions, app).listen(process.env.APP_PORT)   
        } else {
            log('using http: for webhead: ' + (process.env.APP_PORT))
            httpServer = http.createServer(app).listen(process.env.APP_PORT)
        }

		const Users = new User()
        const Pubsub = new PubSubManager()
        const Escrow = new EscrowManager(Pubsub)
		Object.assign(this, {
		    run() {
				log('runnig')
                Pubsub.start()
                Escrow.watchPayments()
                this.startSocketServer()
                Escrow.run()
				this.createEndPoints()
			},
			createEndPoints() {
				const open = new EscrowOpen(myCache, Escrow)
				open.createEndPoint(app, true)
			},
            startSocketServer() {

				let config = { server: httpsServer }
				if (httpsServer == null) {
					config = { server: httpServer }
				}
				const wss = new WebSocketServer(config)
				wss.on('connection', (ws, req) => {
					ws.on('message', async (data) => {
						try {
							if (Pubsub == null) { return }
							if (data == null) { return }

							//log('data', data)
							const json = JSON.parse(data, true)

							switch (json.request) {
								case 'PUBLISH':
									Pubsub.publish(ws, json.channel, json.message)
									break
								case 'PING':
									if ('account' in json.message) {
										log('PING', json.message.account)
										if (!Pubsub.checkChannel(json.message.account)) {
											const res = Pubsub.channelPrivate(json.message.account)
											if (ws?.client_id == null || ws?.client_id == undefined) {
												ws.client_id = json.message.account
											}
											Pubsub.subscribe(ws, json.message.account)
										}
										Pubsub.route({'PONG': json.message.account}, json.message.account)
									}
									break
								case 'SUBSCRIBE': 
									if ('account' in json.message) {
										log('SUBSCRIBE', json.message.account)
										const res = Pubsub.channelPrivate(json.message.account)
										ws.client_id = json.message.account
										Pubsub.subscribe(ws, json.message.account)
										log('message', json.message)
										log('UUID', json.message.uuid)

										Users.updateUser({
											account: json.message.account,
											uuid: json.message.uuid, 
											nodetype: json.message.nodetype,
											version: json.message.version,
											nodewss: json.message.nodewss,
											local: json.message.local,
											currency: json.message.currency,
											user: json.message.user
										})
										Pubsub.route({'SUBSCRIBED': json.message.account}, json.message.account)
									}
									break
								case 'ESCROW': 
									if ('account' in json.message) {
										log('ESCROW', json.message.account)
										Escrow.createEscrow(json.message)
									}
									break
							}
						} catch (error) {
							log(error)
						}
					})
					ws.on('close', (message) => {
						log(`Stopping client connection.... ${ws?.client_id}`, message)
						Pubsub.removeBroker(ws?.client_id)
					})
					ws.on('error', (error) => {
						log('SocketServer error', error)
					})
				})
			},
		})
	}
}

dotenv.config()
log('starting..')
const main = new service()
main.run()
// main.cancel()


