export type SyncConfig = { url: string; token: string };
export type Resolution = "local" | "server";
export type RemoteTodo = {
  id: string;
  title: string;
  completed: boolean;
  created_at: number;
  updated_at: number;
};
export type RemoteRow = {
  id: string;
  record: RemoteTodo | null;
  version: number;
  deleted: boolean;
};
export class SyncError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
export function syncClient(config: SyncConfig) {
  const url = config.url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url) || !config.token.trim())
    throw new Error("서버 URL과 인증 토큰을 입력하세요.");
  return {
    url,
    async request<T>(path: string, body?: unknown): Promise<T> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`${url}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${config.token.trim()}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok)
          throw new SyncError(
            data.message ?? "동기화 요청이 실패했습니다.",
            response.status
          );
        return data as T;
      } catch (error) {
        if (error instanceof SyncError) throw error;
        throw new Error(
          "서버에 연결하지 못했습니다. 로컬 변경은 보존됩니다. 연결을 확인하고 다시 시도하세요."
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
export function assertBinding(
  saved: string | null | undefined,
  binding: string
) {
  if (saved && saved !== binding)
    throw new SyncError(
      "다른 서버 또는 변경된 서버 이력입니다. 로컬 데이터를 보존하고 관리자에게 문의하세요.",
      412
    );
}
