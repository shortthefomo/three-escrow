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

const NodeCache = require('node-cache')
const myCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 })

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
				const open = new EscrowOpen(myCache)
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
									log('PING', json.message.account)
									if (!Pubsub.checkChannel(json.message.account)) {
										const res = Pubsub.channelPrivate(json.message.account)
										Pubsub.subscribe(ws, json.message.account)
									}
									Pubsub.route({'PONG': json.message.account}, json.message.account)
									break
								case 'SUBSCRIBE': 
									log('SUBSCRIBE', json.account)
									if ('account' in json.message) {
										const res = Pubsub.channelPrivate(json.message.account)
										Pubsub.subscribe(ws, json.message.account)
									}
									break
								case 'ESCROW': 
									// add user channel
									log('ESCROW', json.account)
									if ('account' in json.message) {
										const res = Pubsub.channelPrivate(json.message.account)
										Escrow.conditionFulfillment(json.message.account, json.message.destination, json.message.collateral, json.message.amount, json.message.currency, json.message.issuer, json.message.cancel_after)
										Pubsub.subscribe(ws, json.message.account)
									}
									if ('account' in json.message) {
										
									}
									break
							}
						} catch (error) {
							log(error)
						}
					})
					ws.on('close', () => {
						// console.log('Stopping client connection.')
					})
					ws.on('error', (error) => {
						log('SocketServer error')
						log(error)
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


