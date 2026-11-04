# 团队成员指定模型

`src/team-model.ts`（插件 `dsh-config/team-model`）：让 Agent Teams 组长的 `spawn_teammate` 多出 `provider` / `model` / `reasoning_effort` 三个可选参数，按成员指定模型；不传时与原版一样继承组长当时的模型。

## 为什么要补

实验插件 `dsh-experimental-tool-agent-team`（截至 0.2.2-rc.1）的 `spawn_teammate` 只有 name / description / prompt / context，运行时调用 `subagents.startActivation` 也不传 `agentOptions`。底层子智能体服务本身支持 `agentOptions`（spawn / fork 后端都声明了这项能力），选中的模型写进子会话描述符，续跑时恢复。

## 做法

1. 同名工具在同一作用域不能重复注册，所以在 `tools/change`、`agent/created` 时把每个组长已注册的 `spawn_teammate` 定义原地补参数，说明里现读允许的模型（模型看到的工具表每轮现算；参数校验不拒绝多余字段，原工具体忽略它们）。
2. `tools/execute` 包一层：带了模型参数就校验（必须 provider + model 成对，且在允许名单里），用 `llm.resolveCallConfig` 预检线路与推理强度，然后按「组长会话 id + 职责描述」登记。
3. 改 `subagents` 服务原型上的 `startActivation`：同一组长、同一职责描述、没带 `agentOptions` 的创建请求领走登记的模型（领一次即删，调用结束也会撤销）。

## 允许名单

复用子智能体模型选择设置（`subagent-model-selection-settings` 的 `enabled` 与 `allowedModels`，在 profile 的 `cordis.patch.yml` 里），和 `list_subagent_models` 同一份。没开启或名单为空时不显示这段说明，带模型参数招人会报错。

## 风险

依赖实验插件和子智能体服务的内部行为（工具定义是普通可写对象、运行时按 label / parent 调 `startActivation`）。升级 dsh 后如果招人时模型参数不生效或报错，先看这两处是否变了；官方支持按成员指定模型后可删掉本插件。
