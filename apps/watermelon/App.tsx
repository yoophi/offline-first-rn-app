import React from 'react';
import { TodoApp } from '@offline-first/todo-app';
import { createWatermelonRepository } from './src/repository';

const repository = createWatermelonRepository();

export default function App() {
  return <TodoApp repository={repository} databaseName="WatermelonDB" />;
}
