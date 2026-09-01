import { QueryClient } from "@tanstack/react-query";

/**
 * 应用级 QueryClient 工厂。每次调用产生独立实例：真实应用只挂载一次，
 * 测试环境每个 render(<App />) 拿到独立缓存，互不污染。
 *
 * 默认关闭自动重试与窗口聚焦刷新：Tauri invoke 的失败基本是确定性错误
 * （命令不存在、后端崩溃），轮询类查询本身按固定间隔重发，等价于内置重试；
 * WebView 内窗口聚焦语义不可靠，聚焦刷新只会带来多余请求。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
}
