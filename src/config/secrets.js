'use strict';
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// DB_SECRET_NAME must match the actual Secrets Manager secret name
const SECRET_NAME = process.env.DB_SECRET_NAME || 'fuelapp/prod/db';
const REGION = process.env.AWS_REGION || 'eu-west-2';

async function loadSecrets() {
  // If DB_HOST is already set (local dev), skip Secrets Manager
  if (process.env.DB_HOST) {
    console.log('Using env var DB config (local mode)');
    return;
  }
  try {
    console.log(`Loading secrets from Secrets Manager: ${SECRET_NAME} in ${REGION}`);
    const client = new SecretsManagerClient({ region: REGION });
    const cmd = new GetSecretValueCommand({ SecretId: SECRET_NAME });
    const resp = await client.send(cmd);
    const secret = JSON.parse(resp.SecretString);
    process.env.DB_HOST = secret.host;
    process.env.DB_PORT = String(secret.port || '5432');
    process.env.DB_NAME = secret.dbname || 'fuelapp';
    process.env.DB_USER = secret.username;
    process.env.DB_PASS = secret.password;
    console.log(`Secrets loaded OK. DB_HOST=${process.env.DB_HOST}`);
  } catch (err) {
    console.error('Failed to load secrets from Secrets Manager:', err.message);
    throw err;
  }
}

module.exports = { loadSecrets };
