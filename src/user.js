'use strict'

const db = require('./db.js')
const dotenv = require('dotenv')
const debug = require('debug')
const log = debug('escrow:user')

module.exports = class user {
	constructor(PubSubManager) {

        dotenv.config()
        
		Object.assign(this, {
            async getUserToken(account) {
                const query =`SELECT * FROM users WHERE account = '${account}';`
                const rows = await db.query(query)
                if (rows == undefined) {
                    log('SQL Error')
                    log('query', query)
                    return false
                }
                if (rows.length == 1) {
                    log('rows', rows)
                    return rows[0]?.uuid
                }
                return false
            },
            async updateUser(data) {
                console.log('updateUser', data)
                const query = `INSERT HIGH_PRIORITY INTO users(account, uuid, nodetype, version, nodewss, locale, currency, user, app, appkey, lastaccess) VALUES (?) 
                    ON DUPLICATE KEY UPDATE uuid = '${data.uuid}', nodetype='${data.nodetype}', version='${data.version}', nodewss='${data.nodewss}', locale='${data.locale}' , currency='${data.currency}' , user='${data.user}' , app='${data.app}' , appkey='${data.appkey}' , lastaccess='${new Date().toISOString().slice(0, 19).replace('T', ' ')}';`
                    
                const record = []
                record[0] = data.account
                record[1] = data.uuid
                record[2] = data.nodetype
                record[3] = data.version
                record[4] = data.nodewss
                record[5] = data.locale
                record[6] = data.currency
                record[7] = data.user
                record[8] = data.app
                record[9] = data.appkey
                record[10] = new Date().toISOString().slice(0, 19).replace('T', ' ')

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