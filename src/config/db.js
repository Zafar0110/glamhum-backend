 

const mysql = require('mysql2/promise')
const env = require('./env')

const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',
  dateStrings: ['DATE'],  
  timezone: 'Z',
}) 

 
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params)
  return rows
}

 
async function queryOne(sql, params = []) {
  const rows = await query(sql, params)
  return rows.length ? rows[0] : null
}

 
async function transaction(callback) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const result = await callback(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

 
async function testConnection() {
  const connection = await pool.getConnection()
  try {
    await connection.ping()
    return true
  } finally {
    connection.release()
  }
}

module.exports = { pool, query, queryOne, transaction, testConnection }
