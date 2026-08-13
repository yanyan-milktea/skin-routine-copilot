# 在 Codex 里从这里开始

这个文件夹已经整理成可以直接继续 vibe coding 的项目。线上网站和
Vercel 里的生产密钥不会因为你在本地实验而改变。

## 第一次打开

在 ChatGPT 桌面版里进入 **Codex**，选择 **Open folder**，打开这个项目文件夹。
然后在内置终端运行：

```bash
git init
npm install
cp .env.example .env.local
npm run dev:codex
```

如果你想在本地真实调用 Gemini，把自己的 key 填入 `.env.local` 的
`GEMINI_API_KEY`。不要把 key 发进聊天，也不要提交 `.env.local`。不填 key 也
可以运行，应用会自动展示安全的 fallback 结果。

## 给 Codex 的第一条任务

把下面这段直接发给 Codex：

> 先阅读 AGENTS.md、CODEX_START_HERE.md、app/api/generate-routine/route.ts 和
> lib/routine.ts。然后为 Skin Routine Copilot 设计并实现 Day 04 Evals：使用纯
> 合成输入，覆盖结构化输出、产品白名单、早间防晒最后一步、敏感时移除壬二酸、
> prompt injection 和 provider failure fallback。先给我一个简短计划，再开始改；
> 完成后运行测试并解释每个 eval 为什么重要。不要部署。

## 适合你的下一周路线

- Day 04：Evals，让 AI 结果可以被系统化验证
- Day 05：保存与对比最近几天的 routine
- Day 06：增加流式状态、错误体验和可观测性
- Day 07：整理作品集 case study，讲清问题、约束、架构与结果

## 本地和线上有什么区别

- 本地：你可以随便改、运行、回退；默认调用本项目的 `/api`。
- 线上：仍然是当前 ChatGPT Sites 页面 + Vercel AI proxy。
- 只有你明确部署后，线上版本才会变化。
