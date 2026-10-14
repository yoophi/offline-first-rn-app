const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const workspaceRoot = path.resolve(__dirname, '../..');

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [path.join(workspaceRoot, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
