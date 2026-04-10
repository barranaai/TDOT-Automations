const axios = require('axios');
const { apiKey, apiUrl } = require('../../config/monday');

const MAX_RETRIES = 3;
const TIMEOUT_MS  = 30000; // 30 seconds

/**
 * Execute a GraphQL query against the Monday.com API.
 * Retries transient failures (429 rate limit, 5xx server errors, network errors)
 * with exponential backoff.
 *
 * @param {string} gql       - GraphQL query or mutation
 * @param {object} variables  - GraphQL variables
 * @param {number} retries    - Max retries (default 3)
 * @returns {object} response.data.data
 */
async function query(gql, variables = {}, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(
        apiUrl,
        { query: gql, variables },
        {
          headers: {
            Authorization: apiKey,
            'Content-Type': 'application/json',
          },
          timeout: TIMEOUT_MS,
        }
      );

      if (response.data.errors) {
        // Check if it's a rate-limit or transient error worth retrying
        const errMsg = JSON.stringify(response.data.errors);
        const isRateLimit = response.data.errors.some(e =>
          e.message?.toLowerCase().includes('rate') || e.extensions?.code === 'RATE_LIMIT'
        );
        if (isRateLimit && attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          console.warn(`[MondayAPI] Rate limited — retry ${attempt + 1}/${retries} in ${Math.round(delay)}ms`);
          await sleep(delay);
          continue;
        }
        throw new Error(errMsg);
      }

      return response.data.data;
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = !status || status === 429 || status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';

      if (isRetryable && attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        console.warn(`[MondayAPI] ${err.code || status || 'Error'} — retry ${attempt + 1}/${retries} in ${Math.round(delay)}ms`);
        await sleep(delay);
        continue;
      }

      throw err;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { query };
