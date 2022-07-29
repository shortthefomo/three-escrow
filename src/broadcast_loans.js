'use strict'

const db = require('./db.js')

const dotenv = require('dotenv')
const debug = require('debug')
const log = debug('broadcast:loans')

module.exports = class broadcast_loans {
	constructor(Escrow) {
        dotenv.config()

		Object.assign(this, {
            broadcastLoans(Escrow) {
            },
            subscribeLoans(user_token, notification) {
                const record = []
                record[0] = user_token
                record[1] = notification
                
                let query =`INSERT INTO notifications_lenders (user_token, notifications) VALUES (?);`
                const rows = await db.query(query, [record])
                if (rows == undefined) {
                    log('SQL Error')
                    log('query', query)
                    log('record', record)
                }
            }
		})
	}
}