window.__ModuleLoader__.load({
	id: "dsh-config",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/UsageCalendar.tsx
		const price = {
			"deepseek-v4-flash": {
				hit: .02,
				miss: 1,
				output: 2
			},
			"deepseek-v4-pro": {
				hit: .025,
				miss: 3,
				output: 6
			}
		};
		const card = {
			listStyle: "none",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 12,
			background: "var(--dsw-alias-bg-layer-3)",
			overflow: "hidden"
		};
		function total(records) {
			return records.reduce((sum, record) => {
				const unit = price[record.model];
				const cost = (record.cacheReadTokens * unit.hit + (record.inputTokens + record.cacheWriteTokens) * unit.miss + record.outputTokens * unit.output) / 1e6;
				return {
					calls: sum.calls + 1,
					input: sum.input + record.inputTokens,
					output: sum.output + record.outputTokens,
					cacheRead: sum.cacheRead + record.cacheReadTokens,
					cacheWrite: sum.cacheWrite + record.cacheWriteTokens,
					cost: sum.cost + cost
				};
			}, {
				calls: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0
			});
		}
		function dayStart(time) {
			const date = new Date(time);
			date.setHours(0, 0, 0, 0);
			return date.getTime();
		}
		function bucketStart(time, view) {
			const date = new Date(time);
			if (view === "day") return dayStart(time);
			if (view === "week") {
				date.setHours(0, 0, 0, 0);
				date.setDate(date.getDate() - (date.getDay() + 6) % 7);
				return date.getTime();
			}
			date.setHours(0, 0, 0, 0);
			date.setDate(1);
			return date.getTime();
		}
		function previous(start, view) {
			const date = new Date(start);
			if (view === "day") date.setDate(date.getDate() - 1);
			else if (view === "week") date.setDate(date.getDate() - 7);
			else date.setMonth(date.getMonth() - 1);
			return date.getTime();
		}
		function label(time, view) {
			const date = new Date(time);
			if (view === "month") return new Intl.DateTimeFormat("zh-CN", {
				year: "numeric",
				month: "short"
			}).format(date);
			if (view === "week") return `${new Intl.DateTimeFormat("zh-CN", {
				month: "numeric",
				day: "numeric"
			}).format(date)}当周`;
			return new Intl.DateTimeFormat("zh-CN", {
				month: "numeric",
				day: "numeric",
				weekday: "short"
			}).format(date);
		}
		function number(value) {
			return new Intl.NumberFormat("zh-CN", {
				notation: value >= 1e4 ? "compact" : "standard",
				maximumFractionDigits: 1
			}).format(value);
		}
		function money(value) {
			return `¥${value < .01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
		}
		function intensity(cost, maximum) {
			if (cost === 0) return "#e8edf4";
			const ratio = Math.max(.15, cost / Math.max(maximum, 1e-6));
			return `color-mix(in srgb, #16a36a ${Math.round(22 + ratio * 72)}%, #e8edf4)`;
		}
		function Summary({ label: title, value, hint }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: { minWidth: 0 },
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							color: "var(--dsw-alias-label-tertiary)",
							fontSize: 12
						},
						children: title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
						style: {
							display: "block",
							marginTop: 4,
							fontSize: 18,
							letterSpacing: "-0.02em"
						},
						children: value
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							color: "var(--dsw-alias-label-tertiary)",
							fontSize: 11,
							marginTop: 2
						},
						children: hint
					})
				]
			});
		}
		function UsageCalendar() {
			const [open, setOpen] = (0, react.useState)(true);
			const [records, setRecords] = (0, react.useState)([]);
			const [view, setView] = (0, react.useState)("day");
			const [project, setProject] = (0, react.useState)("全部项目");
			const [error, setError] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(true);
			(0, react.useEffect)(() => {
				let stale = false;
				const refresh = async () => {
					try {
						const response = await fetch("/dsh-config/usage", { headers: { "x-dsh-config": "usage-calendar" } });
						const payload = await response.json();
						if (!response.ok || !payload.ok || !Array.isArray(payload.records)) throw new Error("读取用量数据失败");
						if (!stale) {
							setRecords(payload.records);
							setError(null);
						}
					} catch {
						if (!stale) setError("暂时无法读取用量数据，请确认 dsh-config 已完整加载。");
					} finally {
						if (!stale) setLoading(false);
					}
				};
				refresh();
				const timer = window.setInterval(() => {
					refresh();
				}, 15e3);
				return () => {
					stale = true;
					window.clearInterval(timer);
				};
			}, []);
			const projects = (0, react.useMemo)(() => ["全部项目", ...Array.from(new Set(records.map((record) => record.project))).sort()], [records]);
			const filtered = (0, react.useMemo)(() => project === "全部项目" ? records : records.filter((record) => record.project === project), [project, records]);
			const count = view === "day" ? 56 : view === "week" ? 16 : 12;
			const buckets = (0, react.useMemo)(() => {
				const current = bucketStart(Date.now(), view);
				const starts = [];
				for (let index = count - 1, start = current; index >= 0; index -= 1, start = previous(start, view)) starts.unshift(start);
				return starts.map((start) => ({
					start,
					records: filtered.filter((record) => bucketStart(record.at, view) === start)
				}));
			}, [
				count,
				filtered,
				view
			]);
			const displayed = (0, react.useMemo)(() => buckets.flatMap((bucket) => bucket.records), [buckets]);
			const totals = (0, react.useMemo)(() => total(displayed), [displayed]);
			const allTime = (0, react.useMemo)(() => total(filtered), [filtered]);
			const maxCost = Math.max(...buckets.map((bucket) => total(bucket.records).cost), 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					onClick: () => setOpen(!open),
					"aria-expanded": open,
					style: {
						width: "100%",
						padding: "15px 16px",
						border: 0,
						background: "transparent",
						color: "inherit",
						display: "flex",
						textAlign: "left",
						cursor: "pointer",
						alignItems: "center",
						gap: 12
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								width: 30,
								height: 30,
								display: "grid",
								placeItems: "center",
								borderRadius: 8,
								color: "#087443",
								background: "#dff5e8",
								fontWeight: 800
							},
							children: "账"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: { flex: 1 },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "Token 用量日历" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									display: "block",
									marginTop: 3,
									color: "var(--dsw-alias-label-tertiary)",
									fontSize: 12
								},
								children: "仅统计 DeepSeek 官方模型 · 自动保存"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							style: {
								color: "var(--dsw-alias-label-tertiary)",
								transform: open ? "rotate(180deg)" : void 0
							},
							children: "⌄"
						})
					]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						borderTop: "1px solid var(--dsw-alias-border-l2)",
						padding: "18px 16px 16px"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								gap: 12,
								flexWrap: "wrap"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								role: "tablist",
								"aria-label": "统计粒度",
								style: {
									display: "inline-flex",
									padding: 3,
									border: "1px solid var(--dsw-alias-border-l2)",
									borderRadius: 9
								},
								children: [
									["day", "日"],
									["week", "周"],
									["month", "月"]
								].map(([id, text]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									role: "tab",
									"aria-selected": view === id,
									onClick: () => setView(id),
									style: {
										border: 0,
										borderRadius: 6,
										padding: "5px 11px",
										cursor: "pointer",
										font: "inherit",
										fontSize: 12,
										color: "inherit",
										background: view === id ? "var(--dsw-alias-bg-layer-2)" : "transparent",
										boxShadow: view === id ? "0 1px 2px #00000012" : void 0
									},
									children: text
								}, id))
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									fontSize: 12,
									color: "var(--dsw-alias-label-tertiary)"
								},
								children: ["项目　", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									value: project,
									onChange: (event) => setProject(event.target.value),
									style: {
										color: "inherit",
										background: "transparent",
										border: "1px solid var(--dsw-alias-border-l2)",
										borderRadius: 7,
										padding: "5px 7px"
									},
									children: projects.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", { children: item }, item))
								})]
							})]
						}),
						error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							role: "status",
							style: {
								color: "var(--dsw-alias-label-error)",
								fontSize: 12
							},
							children: error
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								marginTop: 18,
								overflowX: "auto",
								paddingBottom: 3
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "grid",
									gridTemplateColumns: `repeat(${view === "day" ? 8 : 6}, minmax(16px, 1fr))`,
									...view === "day" ? {
										gridTemplateRows: "repeat(7, minmax(16px, 1fr))",
										gridAutoFlow: "column"
									} : {},
									gap: 5,
									minWidth: 350
								},
								children: buckets.map((bucket) => {
									const item = total(bucket.records);
									return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										title: `${label(bucket.start, view)}：${number(item.input + item.cacheRead + item.cacheWrite + item.output)} Token，${money(item.cost)}`,
										style: {
											aspectRatio: "1",
											borderRadius: 3,
											background: intensity(item.cost, maxCost),
											outline: item.cost > 0 ? "1px solid #08744322" : "1px solid #dbe2ea"
										}
									}, bucket.start);
								})
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								justifyContent: "space-between",
								marginTop: 7,
								color: "var(--dsw-alias-label-tertiary)",
								fontSize: 11
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label(buckets[0]?.start ?? Date.now(), view) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									"用量低　",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { color: "#16a36a" },
										children: "■ ■ ■"
									}),
									"　用量高"
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label(buckets.at(-1)?.start ?? Date.now(), view) })
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "grid",
								gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
								gap: 12,
								marginTop: 20,
								padding: "13px 0",
								borderTop: "1px solid var(--dsw-alias-border-l2)",
								borderBottom: "1px solid var(--dsw-alias-border-l2)"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Summary, {
									label: "实际费用",
									value: money(totals.cost),
									hint: `全部累计 ${money(allTime.cost)}`
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Summary, {
									label: "Token 总数",
									value: number(totals.input + totals.cacheRead + totals.cacheWrite + totals.output),
									hint: `${number(totals.calls)} 次模型调用`
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Summary, {
									label: "输入 / 输出",
									value: `${number(totals.input + totals.cacheWrite)} / ${number(totals.output)}`,
									hint: "未命中输入 / 输出"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Summary, {
									label: "缓存命中",
									value: number(totals.cacheRead),
									hint: `缓存写入 ${number(totals.cacheWrite)}`
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								margin: "12px 0 0",
								color: "var(--dsw-alias-label-tertiary)",
								fontSize: 11,
								lineHeight: 1.55
							},
							children: loading ? "正在读取用量…" : "费用按 DeepSeek 官方 V4-Flash / V4-Pro 当前人民币单价估算；缓存写入按未命中输入计费。"
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/index.ts
		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register({
					name: "settings.plugin.item",
					id: "dsh-config",
					order: 15,
					inject: () => ({})
				}, UsageCalendar);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
