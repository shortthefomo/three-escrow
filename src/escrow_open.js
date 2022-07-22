'use strict'

const { XrplClient } = require('xrpl-client')

const db = require('./db.js')
const dotenv = require('dotenv')
const debug = require('debug')
const log = debug('escrow:open')

module.exports = class escrow_open {
	constructor(nodeCache, Escrow) {
        
        dotenv.config()

        const nodes = process.env.XRPL_MAINNET.split(',')
        const client = new XrplClient(nodes)
        const myCache = nodeCache
        
		Object.assign(this, {
            createEndPoint(app, testing = false) {
                const self = this
                app.get('/api/v1/loans/user', async function(req, res) {
                    log('Called: ' + req.route.path)
                    log(req.query)

                    if (testing) {
                        res.header("Access-Control-Allow-Origin", "*")
                        if (!('account' in req.query)) { return res.json({ 'error' : 'missing parameter account'}) }

                        

                        const key = req.route.path  + '/' + Object.keys(req.query).map(function(e){return req.query[e]}).join("/")
                        const value = myCache.get(key)
                        if ( value != undefined ) {
                            log('serving cached: ' + req.route.path)
                            res.json(value)
                        }
                        if ( value == undefined ) {
                            log('serving raw fetch: ' + req.route.path)
                            self.findUser(req.query.account).then((data) => {
                                //ttl in seconds 2
                                myCache.set(key, data, 2)
                                res.json(data)
                            })
                        }
                        log('response sent: ' + req.route.path)
                    }
                })

                app.get('/api/v1/loans/trustlines', async function(req, res) {
                    log('Called: ' + req.route.path)
                    log(req.query)

                    if (testing) {
                        res.header("Access-Control-Allow-Origin", "*")
                        if (!('account' in req.query)) { return res.json({ 'error' : 'missing parameter account'}) }

                        const key = req.route.path  + '/' + Object.keys(req.query).map(function(e){return req.query[e]}).join("/")
                        const value = myCache.get(key)
                        if ( value != undefined ) {
                            log('serving cached: ' + req.route.path)
                            res.json(value)
                        }
                        if ( value == undefined ) {
                            log('serving raw fetch: ' + req.route.path)
                            self.getTrustlines(req.query.account).then((data) => {
                                //ttl in seconds 2600 1 hour
                                myCache.set(key, data, 3600)
                                res.json(data)
                            })
                        }
                        log('response sent: ' + req.route.path)
                    }
                })

                app.get('/api/v1/escrow/cancel', async function(req, res) {
                    log('Called: ' + req.route.path)
                    log(req.query)

                    if (testing) {
                        res.header("Access-Control-Allow-Origin", "*")
                        if (!('escrow_condition' in req.query)) { return res.json({ 'error' : 'missing parameter escrow_condition'}) }
                        if (!('sequence' in req.query)) { return res.json({ 'error' : 'missing parameter sequence'}) }
                        if (!('account' in req.query)) { return res.json({ 'error' : 'missing parameter account'}) }

                        self.cancelEscrow(req.query.sequence, req.query.account, req.query.escrow_condition)
                        log(`cancelEscrow: ${req.query.escrow_condition} ` + req.route.path)
                    }
                })

            },
            cancelEscrow(sequence, account, escrow_condition) {
                Escrow.cancelEscrow(sequence, account, escrow_condition)
            },
            async findUser(account) {
                const query =`SELECT * FROM users WHERE account = '${account}';`
                const rows = await db.query(query)
                if (rows == undefined) {
                    log('SQL Error')
					log(query)
                    return false
                }
                if (rows.length >= 0) {
                    return true
                }
                return false
            },
            async findOpenLoans(account) {
                const query =`SELECT currency, issuer, rate, amount, collateral, account, destination, cancel_after, escrow.escrow_condition FROM escrow 
                    LEFT JOIN escrow_completed ON (escrow.escrow_condition = escrow_completed.escrow_condition)
                    WHERE ((escrow_completed.engine_result != 'tesSUCCESS' AND escrow_completed.engine_result != 'tecNO_TARGET') OR escrow_completed.engine_result IS NULL)
                    AND account='${account}';`
                const rows = await db.query(query)
                if (rows == undefined) {
                    log('SQL Error')
					log(query)
                    return []
                }
                return rows
            },
            async getTrustlines(account) {
                const request = {
                    id: 1,
                    command: 'account_lines',
                    account: account,
                    strict: true
                }
                let ledger_result = await client.send(request)

                // log('ledger_result', ledger_result)
                if ('lines' in ledger_result) {                    
                    return ledger_result.lines 
                }
                return []
            }
        })
	}
}