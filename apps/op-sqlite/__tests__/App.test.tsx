jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('../src/repository', () => ({
  createOpSqliteRepository: () => ({
    initialize: async () => {},
    list: async () => [],
    add: async () => {},
    update: async () => {},
    remove: async () => {},
  }),
}));
import App from '../App';

test('renders the local Todo app', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
  });
  expect(
    renderer!.root.findByProps({ accessibilityRole: 'header' }).props.children,
  ).toContain('OP-SQLite');
  await ReactTestRenderer.act(async () => {
    renderer!.unmount();
  });
});
