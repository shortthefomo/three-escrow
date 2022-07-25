'use strict'

const db = require('./db.js')

const dotenv = require('dotenv')
const debug = require('debug')
const log = debug('escrow:watch')
const EventEmitter = require('node:events')

module.exports = class escrow_watch extends EventEmitter {
	constructor(Escrow, EscrowBooks) {
        super()

        dotenv.config()
        
        let timeout = null

		Object.assign(this, {
            run() {
                this.startFindAndCancel()
                EscrowBooks.run()
                this.listenFinishEscrows()
            },
            stop() {
                if (timeout != null) {
                    clearTimeout(timeout)
                }
            },
            startFindAndCancel() {
                const self = this
                timeout = setTimeout(() => {
                    self.findAndCancelExpiredEscrows()
                }, 10_000)
            },
            async findAndCancelExpiredEscrows() {
                const rippleOffset = 946684800
                const CancelAfter = Math.floor(Date.now() / 1000) - rippleOffset
                log('CancelAfter', CancelAfter)
                const query =`SELECT escrow.sequence, escrow.escrow_condition, escrow.account, escrow.destination FROM escrow 
                    LEFT JOIN escrow_completed ON (escrow.escrow_condition = escrow_completed.escrow_condition)
                    WHERE escrow.cancel_after <= ${CancelAfter}
                    AND (escrow_completed.engine_result != 'tesSUCCESS' OR escrow_completed.engine_result IS NULL);`
                const rows = await db.query(query)

                
                if (rows == undefined || rows.length == 0) {
                    this.startFindAndCancel()
                    return 
                }
                log('findAndCancelExpiredEscrows', rows.length)
                for (let index = 0; index < rows.length; index++) {
                    const element = rows[index]
                    await Escrow.cancelEscrow(element.sequence, element.account, element.escrow_condition)
                }
                
                this.startFindAndCancel()
            },
            // async findAndFinishConditionalEscrows() {
            //     const rippleOffset = 946684800
            //     const FinishAfter = Math.floor((new Date().getTime()) / 1000) - rippleOffset

            //     const query =`SELECT escrow.sequence, escrow.escrow_condition, escrow.account FROM escrow 
            //         LEFT JOIN escrow_completed ON (escrow.escrow_condition = escrow_completed.escrow_condition)
            //         WHERE escrow.finish_after <= ${FinishAfter} AND ((escrow_completed.engine_result != 'tesSUCCESS' AND escrow_completed.engine_result != 'tecNO_TARGET') OR escrow_completed.engine_result IS NULL);`
            //     const rows = await db.query(query)

                
            //     if (rows == undefined || rows.length == 0) {
            //         return 
            //     }
            //     log('findAndFinishConditionalEscrows', rows.length)
            //     for (let index = 0; index < rows.length; index++) {
            //         const element = rows[index]
            //         Escrow.cancelEscrow(element.sequence, element.account, element.escrow_condition)
            //     }
            // },
            listenFinishEscrows() {
                EscrowBooks.on('finishEscrow', (data) => {
                    Escrow.finishEscrow(data)
                })
            }
		})
	}
}