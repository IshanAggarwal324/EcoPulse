/**
 * Guards ops-only CLI scripts from accidental production execution.
 * Set ALLOW_DEV_SCRIPTS=true locally to run test/blockchain/bootstrap tools.
 */
const requireDevScript = (scriptName) => {
  if (process.env.NODE_ENV === 'production') {
    console.error(`[${scriptName}] Refusing to run in production.`);
    process.exit(1);
  }

  if (process.env.ALLOW_DEV_SCRIPTS !== 'true') {
    console.error(`[${scriptName}] Dev scripts are disabled.`);
    console.error('Set ALLOW_DEV_SCRIPTS=true in your environment to run this tool.');
    process.exit(1);
  }
};

const requireBootstrapSecret = () => {
  const secret = process.env.BOOTSTRAP_ADMIN_SECRET;
  const provided = process.argv.find((arg) => arg.startsWith('--secret='))?.slice('--secret='.length)
    || process.env.BOOTSTRAP_ADMIN_SECRET_INPUT;

  if (!secret || secret.length < 16) {
    console.error('BOOTSTRAP_ADMIN_SECRET must be set in .env (min 16 characters).');
    process.exit(1);
  }

  if (!provided || provided !== secret) {
    console.error('Invalid or missing bootstrap secret. Pass --secret=<value> or set BOOTSTRAP_ADMIN_SECRET_INPUT.');
    process.exit(1);
  }
};

module.exports = { requireDevScript, requireBootstrapSecret };
