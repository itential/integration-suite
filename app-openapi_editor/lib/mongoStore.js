'use strict';

/**
 * Swappable template storage interface.
 *
 * Both stores implement:
 *   findByName(name) -> Promise<doc|null>
 *   findById(id) -> Promise<doc|null>
 *   create(doc) -> Promise<doc>
 *   update(id, patch) -> Promise<doc|null>
 *   delete(id) -> Promise<boolean>
 *   list() -> Promise<doc[]>
 */

const COLLECTION_NAME = 'jinja2_expanded_templates';

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return 'tpl_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * In-memory Map-based store. Used for unit tests and as a local dev fallback
 * when no service_config / mongoProps is available.
 */
class InMemoryTemplateStore {
  constructor() {
    this.byId = new Map();
  }

  async findByName(name) {
    for (const doc of this.byId.values()) {
      if (doc.name === name) return this._clone(doc);
    }
    return null;
  }

  async findById(id) {
    const doc = this.byId.get(id);
    return doc ? this._clone(doc) : null;
  }

  async create(doc) {
    const id = doc._id || makeId();
    const record = Object.assign(
      {
        _id: id,
        type: 'page',
        body: '',
        tags: [],
        deviceType: null,
        environment: { trimBlocks: false, lstripBlocks: false, autoescape: false, extensions: [] },
        versions: [],
        testScenarios: [],
        createdBy: doc.createdBy || 'system',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
      doc,
      { _id: id },
    );
    // seed the version history with the initial body
    record.versions = record.versions.length
      ? record.versions
      : [{ version: 1, body: record.body, savedAt: nowIso(), savedBy: record.createdBy }];
    this.byId.set(id, record);
    return this._clone(record);
  }

  async update(id, patch) {
    const existing = this.byId.get(id);
    if (!existing) return null;
    const bumpVersion = typeof patch.body === 'string' && patch.body !== existing.body;
    const updated = Object.assign({}, existing, patch, { _id: id, updatedAt: nowIso() });
    if (bumpVersion) {
      const nextVersion = (existing.versions || []).reduce((m, v) => Math.max(m, v.version), 0) + 1;
      updated.versions = (existing.versions || []).concat([
        { version: nextVersion, body: patch.body, savedAt: nowIso(), savedBy: patch.updatedBy || existing.createdBy },
      ]);
    }
    this.byId.set(id, updated);
    return this._clone(updated);
  }

  async delete(id) {
    return this.byId.delete(id);
  }

  async list() {
    return Array.from(this.byId.values()).map((d) => this._clone(d));
  }

  _clone(doc) {
    return JSON.parse(JSON.stringify(doc));
  }
}

/**
 * Real Mongo-backed store.
 *
 * Connection info is resolved via the same lazy-connect convention
 * established in app-openapi_editor's `_getDb` (see that app's src.js): on a
 * real Platform 6 instance, the resolved Service Instance properties for
 * this app (the "properties" block of its properties.json, containing
 * mongoProps) are exposed via a process-wide implicit global named
 * `service_config`, populated by
 * /opt/itential/platform/server/core/Service/ServiceBootstrap.js at service
 * startup - NOT via a bare `properties` global as older Pronghorn docs
 * describe.
 *
 * A single MongoClient is lazily opened once and cached for the life of the
 * process, same as the reference app. Falls back to environment variables
 * (and finally localhost defaults) when service_config is unavailable, so
 * this can still be pointed at a real Mongo instance outside of a live IAP
 * deployment (e.g. for manual smoke testing) without any code changes.
 */
class MongoTemplateStore {
  constructor() {
    this.client = null;
  }

  /**
   * Lazily open (and cache) a single MongoClient for the life of the app.
   * Mirrors app-openapi_editor's `_getDb` pattern exactly.
   */
  async _getDb() {
    const instanceProps = (typeof service_config !== 'undefined' && service_config && service_config.properties)
      ? service_config.properties
      : {};

    const props = instanceProps.mongoProps || {
      host: process.env.ENHANCED_JINJA2_MONGO_HOST || '127.0.0.1',
      port: process.env.ENHANCED_JINJA2_MONGO_PORT || 27017,
      database: process.env.ENHANCED_JINJA2_MONGO_DB || 'itential-master',
    };

    const auth = props.username
      ? `${encodeURIComponent(props.username)}:${encodeURIComponent(props.password)}@`
      : '';
    const uri = `mongodb://${auth}${props.host}:${props.port}/${props.database}`;

    if (this.client) {
      return this.client.db(props.database);
    }

    // Lazily require mongodb so it is never a hard dependency at module load
    // time (keeps unit tests, which only ever construct InMemoryTemplateStore,
    // from needing a running Mongo instance).
    // eslint-disable-next-line global-require
    const { MongoClient } = require('mongodb');
    const client = await MongoClient.connect(uri, { useUnifiedTopology: true });
    this.client = client;
    return client.db(props.database);
  }

  async _getCollection() {
    const db = await this._getDb();
    return db.collection(COLLECTION_NAME);
  }

  async findByName(name) {
    const col = await this._getCollection();
    return col.findOne({ name });
  }

  async findById(id) {
    const col = await this._getCollection();
    return col.findOne({ _id: id });
  }

  async create(doc) {
    const col = await this._getCollection();
    const id = doc._id || makeId();
    const record = Object.assign(
      {
        _id: id,
        type: 'page',
        body: '',
        tags: [],
        deviceType: null,
        environment: { trimBlocks: false, lstripBlocks: false, autoescape: false, extensions: [] },
        versions: [{ version: 1, body: doc.body || '', savedAt: nowIso(), savedBy: doc.createdBy || 'system' }],
        testScenarios: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
      doc,
      { _id: id },
    );
    await col.insertOne(record);
    return record;
  }

  async update(id, patch) {
    const col = await this._getCollection();
    const existing = await col.findOne({ _id: id });
    if (!existing) return null;
    const bumpVersion = typeof patch.body === 'string' && patch.body !== existing.body;
    const update = Object.assign({}, patch, { updatedAt: nowIso() });
    if (bumpVersion) {
      const nextVersion = (existing.versions || []).reduce((m, v) => Math.max(m, v.version), 0) + 1;
      update.versions = (existing.versions || []).concat([
        { version: nextVersion, body: patch.body, savedAt: nowIso(), savedBy: patch.updatedBy || existing.createdBy },
      ]);
    }
    await col.updateOne({ _id: id }, { $set: update });
    return col.findOne({ _id: id });
  }

  async delete(id) {
    const col = await this._getCollection();
    const res = await col.deleteOne({ _id: id });
    return res.deletedCount > 0;
  }

  async list() {
    const col = await this._getCollection();
    return col.find({}).toArray();
  }
}

/**
 * Factory: pick the real Mongo-backed store if service_config's
 * mongoProps is present, otherwise fall back to the in-memory store with a
 * console warning (expected in local dev/tests, not for real deployments).
 */
function createStore() {
  /* eslint-disable no-undef */
  const hasServiceConfig = typeof service_config !== 'undefined'
    && service_config
    && service_config.properties
    && service_config.properties.mongoProps;
  /* eslint-enable no-undef */
  if (hasServiceConfig) {
    return new MongoTemplateStore();
  }
  // eslint-disable-next-line no-console
  console.warn(
    '[Jinja2Expanded] service_config.properties.mongoProps not found - using InMemoryTemplateStore. '
      + 'This is expected in local dev/tests, but NOT for a real IAP deployment.',
  );
  return new InMemoryTemplateStore();
}

module.exports = { InMemoryTemplateStore, MongoTemplateStore, createStore };
