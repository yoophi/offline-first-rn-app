import React from 'react';
import { TodoApp } from '@offline-first/todo-app';
import { createOpSqliteRepository } from './src/repository';

const repository = createOpSqliteRepository();

export default function App() {
  return <TodoApp repository={repository} databaseName="OP-SQLite" />;
}
