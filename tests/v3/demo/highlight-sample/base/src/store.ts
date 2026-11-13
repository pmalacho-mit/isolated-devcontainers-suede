export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

export class Store {
  private items: Todo[] = [];

  add(title: string): Todo {
    const todo = { id: this.items.length + 1, title, done: false };
    this.items.push(todo);
    return todo;
  }

  remaining(): number {
    return this.items.filter((t) => !t.done).length;
  }
}
