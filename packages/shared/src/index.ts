export type Todo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
};

export interface TodoRepository {
  sync?(
    config: { url: string; token: string },
    resolution?: "local" | "server"
  ): Promise<void>;
  initialize(): Promise<void>;
  list(): Promise<Todo[]>;
  add(title: string): Promise<void>;
  update(
    id: string,
    patch: { title?: string; completed?: boolean }
  ): Promise<void>;
  remove(id: string): Promise<void>;
}
