"use strict";

function buildResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://www.justtodothings.com",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS,PATCH,PUT,DELETE",
      "Access-Control-Allow-Headers": "content-type,authorization,x-api-key,application/json,content-length,x-amz-date,x-requested-with,x-amz-security-token",
      "Access-Control-Expose-Headers": "content-type",
      "Access-Control-Max-Age": "600",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

module.exports = { buildResponse };