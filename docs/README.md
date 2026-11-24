# _src/docs 目录说明

本目录为开发参考文档，线上运行不依赖。

- `0001_initial.sql`（在 migrations/）：参考建表语句，线上由 Worker 运行时自动建表 / 补列。
- 项目根目录文档：
  - `CHANGELOG.md`：版本更新日志（v3.4 起）。
  - `升级说明.md`：旧版升级操作步骤。
  - `Cloudflare部署完整教程.md`：浏览器免终端部署全流程。
  - `部署说明.md`：功能表 + FAQ 速查。
  - `reward/`：README 赞助区使用的赞赏码图片。
  - `赞赏话术.md` / `赞赏话术-正式版.md`：页面赞赏文案。
  - `.selftest/`：本地自测（node:sqlite 替身 D1 + Playwright），不随线上部署。
