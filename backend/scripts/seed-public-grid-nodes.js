#!/usr/bin/env node

/**
 * Seed public grid-zone nodes + default sources (Sub-module 1.5.6).
 *
 * Creates one `EnergyNode` (ingestionMode: public_api) per provider and links a
 * default `PublicGridSource` to it, using each adapter's catalog defaults.
 *
 * Grid-zone nodes are national/regional aggregates reported in MW — distinct
 * from home IoT (kW) nodes. They must NOT carry a DeviceCredential.
 *
 * Ownership: EnergyNode requires a userId. The owner is resolved from
 *   PUBLIC_GRID_SYSTEM_USER_ID (preferred) or the first admin user. The
 *   script refuses to run if no owner can be found (it never fabricates a user).
 *
 * Modes:
 *   --dry-run  (default) print the plan; write nothing.
 *   --apply    perform the upserts.
 *   --provider smard_de  restrict to one providerKey (repeatable).
 *
 * Usage:
 *   node scripts/seed-public-grid-nodes.js --dry-run
 *   node scripts/seed-public-grid-nodes.js --apply
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const mongoose = require('mongoose');
const EnergyNode = require('../models/EnergyNode');
const PublicGridSource = require('../models/PublicGridSource');
const User = require('../models/User');
const { providerCatalog } = require('../services/publicGrid/adapters/registry');
const publicGridService = require('../services/publicGrid/publicGridService');

const argv = process.argv.slice(2);
const dryRun = !argv.includes('--apply');
const providerFilter = argv
  .reduce((acc, a, i) => {
    if (a === '--provider' && argv[i + 1]) acc.push(argv[i + 1]);
    return acc;
  }, []);

// Per-provider node metadata (grid zones reported in MW).
const NODE_META = {
  smard_de: { name: 'Germany — SMARD National Grid', nodeType: 'prosumer', sourceType: 'other', location: 'Germany' },
  cea_in: { name: 'India — CEA All-India Generation', nodeType: 'producer', sourceType: 'other', location: 'India' },
  eia_us: { name: 'USA — EIA Electric Grid', nodeType: 'prosumer', sourceType: 'other', location: 'United States' },
  fingrid_fi: { name: 'Finland — Fingrid Grid', nodeType: 'prosumer', sourceType: 'other', location: 'Finland' },
  entsoe_eu: { name: 'Europe — ENTSO-E Transparency (DE zone)', nodeType: 'prosumer', sourceType: 'other', location: 'Europe / Germany' },
};

const resolveOwner = async () => {
  const explicit = process.env.PUBLIC_GRID_SYSTEM_USER_ID;
  if (explicit && mongoose.Types.ObjectId.isValid(explicit)) {
    const user = await User.findById(explicit).lean();
    if (user) return user;
  }
  const admin = await User.findOne({ role: 'admin' }).lean();
  if (!admin) {
    throw new Error(
      'No owner resolved: set PUBLIC_GRID_SYSTEM_USER_ID or ensure an admin user exists.',
    );
  }
  console.warn(`[seed] using admin user ${admin.email} as grid-node owner (set PUBLIC_GRID_SYSTEM_USER_ID to override).`);
  return admin;
};

const planProviders = () =>
  providerCatalog().filter((p) => providerFilter.length === 0 || providerFilter.includes(p.providerKey));

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`[seed] connected. mode=${dryRun ? 'DRY-RUN' : 'APPLY'}`);

  const owner = await resolveOwner();
  const providers = planProviders();

  if (providers.length === 0) {
    console.log('[seed] no providers matched the filter.');
    return;
  }

  const summary = [];

  for (const provider of providers) {
    const meta = NODE_META[provider.providerKey] || {
      name: provider.displayName,
      nodeType: 'producer',
      sourceType: 'other',
      location: null,
    };

    // Upsert node (idempotent on name + ingestionMode).
    let node = await EnergyNode.findOne({
      name: meta.name,
      ingestionMode: 'public_api',
    }).exec();

    const nodeFields = {
      nodeType: meta.nodeType,
      sourceType: meta.sourceType,
      status: 'active',
      ingestionMode: 'public_api',
      location: meta.location,
      userId: owner._id,
    };

    if (!node) {
      if (!dryRun) node = await EnergyNode.create({ name: meta.name, ...nodeFields });
      summary.push({ provider: provider.providerKey, node: meta.name, action: 'create-node' });
    } else {
      if (!dryRun) {
        Object.assign(node, nodeFields);
        await node.save();
      }
      summary.push({ provider: provider.providerKey, node: meta.name, action: 'update-node' });
    }

    // Upsert source (idempotent on providerKey).
    const existing = await PublicGridSource.findOne({ providerKey: provider.providerKey }).lean();
    if (existing) {
      if (!dryRun) {
        await PublicGridSource.updateOne(
          { providerKey: provider.providerKey },
          {
            $set: {
              displayName: provider.displayName,
              attribution: provider.attribution,
              apiKeyEnvVar: provider.apiKeyEnvVar,
              config: provider.defaultConfig,
              nodeId: node ? node._id : existing.nodeId,
            },
          },
        );
      }
      summary.push({ provider: provider.providerKey, source: 'update' });
    } else {
      if (!dryRun) {
        await publicGridService.createSource({
          providerKey: provider.providerKey,
          displayName: provider.displayName,
          attribution: provider.attribution,
          enabled: false, // fail-closed: an admin must turn each source on
          nodeId: String(node._id),
          config: provider.defaultConfig,
          apiKeyEnvVar: provider.apiKeyEnvVar,
          createdBy: owner._id,
        });
      }
      summary.push({ provider: provider.providerKey, source: 'create', enabled: false });
    }
  }

  console.table(summary);
  if (dryRun) {
    console.log('[seed] dry-run complete. Re-run with --apply to write.');
  } else {
    console.log('[seed] apply complete. Remember to set API key env vars and enable sources in the admin UI.');
  }
};

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] failed:', err.message);
    process.exit(1);
  });
