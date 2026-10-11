---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild the extension against `eve` 0.76.3 and raise the `eve` peer floor to `>=0.76.2`

`@upstash/agentkit-eve-extension@0.16.0` was built with eve 0.74.0 and stamps tool contract 78 / dynamicTool 73 /
hook 39. This release is rebuilt on eve 0.76.3, whose manifest requires tool 85 / dynamicTool 79 / hook 44; eve
0.76.0 and earlier do not support them (`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`),
so the `eve` peer floor moves from `>=0.74.0` to `>=0.76.2`.
