const axios = require('axios');
const { apiKey, apiUrl } = require('../../config/monday');

async function query(gql, variables = {}) {
  const response = await axios.post(
    apiUrl,
    { query: gql, variables },
    {
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
    }
  );

  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors));
  }

  return response.data.data;
}

module.exports = { query };
