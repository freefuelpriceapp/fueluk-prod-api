'use strict';
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const SECRET_NAME = process.env.DB_SECRET_NAME || 'fuelapp/prod-db-credentials';
const REGION = process.env.AWS_REGION || 'eu-west-2';

async function loadSecrets() {
  if (process.env.DB_HOST) {
    console.log('Using env var DB config (local mode)');
    return;
  }
  try {
    const client = new SecretsManagerClient({ region: REGION });
    const cmd = new GetSecretValueCommand({ SecretId: SECRET_NAME });
    const resp = await client.send(cmd);
    const secret = JSON.parse(resp.SecretString);
    process.env.DB_HOST = secret.host;
    process.env.DB_PORT = secret.port || '5432';
    process.env.DB_NAME = secret.dbname || 'fuelapp';
    process.env.DB_USER = secret.username;
    process.env.DB_PASS = secret.password;
    console.log('Secrets loaded from Secrets Manager');
  } catch (err) {
    console.error('Failed to load secrets:', err.message);
    throw err;
  }
}

module.exports = { loadSecrets };
