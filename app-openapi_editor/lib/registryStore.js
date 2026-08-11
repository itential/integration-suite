'use strict';

/**
 * Storage for the filter/test/global registry (jinja2_expanded_registry
 * collection) - deliberately separate from the template store since this is
 * environment-wide configuration, not per-template data. Mirrors
 * mongoStore.js's InMemory/Mongo dual-implementation pattern exactly.
 */

const COLLECTION_NAME = 'jinja2_expanded_registry';

function makeId() {
  return 'reg_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

class InMemoryRegistryStore {
  constructor() {
    this.byId = new Map();
  }

  async list() {
    return Array.from(this.byId.values());
  }

  async create(entry) {
    const id = makeId();
    const record = Object.assign({ _id: id, createdAt: new Date().toISOString() }, entry, { _id: id });
    this.byId.set(id, record);
    return record;
  }

  async delete(id) {
    return this.byId.delete(id);
  }
}

class MongoRegistryStore {
  async _getCollection() {
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
    if (!this._client) {
      // eslint-disable-next-line global-require
      const { MongoClient } = require('mongodb');
      this._client = await MongoClient.connect(uri, { useUnifiedTopology: true });
    }
    return this._client.db(props.database).collection(COLLECTION_NAME);
  }

  async list() {
    const col = await this._getCollection();
    return col.find({}).toArray();
  }

  async create(entry) {
    const col = await this._getCollection();
    const id = makeId();
    const record = Object.assign({ _id: id, createdAt: new Date().toISOString() }, entry, { _id: id });
    await col.insertOne(record);
    return record;
  }

  async delete(id) {
    const col = await this._getCollection();
    const res = await col.deleteOne({ _id: id });
    return res.deletedCount > 0;
  }
}

function createRegistryStore() {
  /* eslint-disable no-undef */
  const hasServiceConfig = typeof service_config !== 'undefined'
    && service_config
    && service_config.properties
    && service_config.properties.mongoProps;
  /* eslint-enable no-undef */
  if (hasServiceConfig) return new MongoRegistryStore();
  // eslint-disable-next-line no-console
  console.warn(
    '[Jinja2Expanded] service_config.properties.mongoProps not found - using InMemoryRegistryStore. '
      + 'This is expected in local dev/tests, but NOT for a real IAP deployment.',
  );
  return new InMemoryRegistryStore();
}

module.exports = { InMemoryRegistryStore, MongoRegistryStore, createRegistryStore };
