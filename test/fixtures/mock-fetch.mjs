// 仅用于真实 CLI 子进程 E2E：在进程内拦截 SDK 的 fetch，不访问网络。
if (process.env.XYCLI_E2E_MOCK_FETCH === "1") {
  let requestCount = 0;

  globalThis.fetch = async (_input, init = {}) => {
    requestCount += 1;
    const body = typeof init.body === "string" ? init.body : "{}";
    const request = JSON.parse(body);
    const hasToolResult = request.messages?.some((message) => message.role === "tool");
    const payload = hasToolResult
      ? {
          id: `mock-${requestCount}`,
          object: "chat.completion",
          created: 1,
          model: "deepseek-chat",
          choices: [{
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "已完成真实 CLI 文件列表测试。" },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      : {
          id: `mock-${requestCount}`,
          object: "chat.completion",
          created: 1,
          model: "deepseek-chat",
          choices: [{
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call-list",
                type: "function",
                function: { name: "terminal_exec", arguments: "{\"command\":\"ls\"}" },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
