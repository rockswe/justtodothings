"use strict";

const pg = require("pg");

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,     
  port: process.env.DB_PORT || 5432,   
  user: process.env.DB_USER,           
  password: process.env.DB_PASS,     
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: true }      
});

module.exports = { pool };