'use strict'

const db = require('./db.js')
const dotenv = require('dotenv')
const debug = require('debug')
const log = debug('escrow:user')

module.exports = class user {
	constructor(PubSubManager) {

        dotenv.config()
        
		Object.assign(this, {
            async userUUID(account) {
                const query =`SELECT * FROM users WHERE account = '${account}';`
                const rows = await db.query(query)
                if (rows == undefined) {
                    log('SQL Error')
                    log('query', query)
                    return false
                }
                return rows
            },
            async updateUser(data) {
                const query = `INSERT HIGH_PRIORITY INTO users(account, uuid, nodetype, version, nodewss, locale, currency, user) VALUES (?) 
                    ON DUPLICATE KEY UPDATE uuid = '${data.uuid}', nodetype='${data.nodetype}', version='${data.version}', nodewss='${data.nodewss}', locale='${data.locale}' , currency='${data.currency}' , user='${data.user}';`
                    
                const record = []
                record[0] = data.account
                record[1] = data.uuid
                record[2] = data.nodetype
                record[3] = data.version
                record[4] = data.nodewss
                record[5] = data.locale
                record[6] = data.currency
                record[7] = data.user

                const rows = await db.query(query, [record])
                if (rows == undefined) {
                    log('SQL Error')
                    log('query', query)
                    log('record', record)
                    return false
                }
                return rows
			},
		})
	}
}