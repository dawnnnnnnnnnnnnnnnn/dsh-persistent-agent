/**
 * SPDX-FileCopyrightText: 2026 dsh-persistent-agent contributors
 * SPDX-License-Identifier: MIT
 *
 * 来源声明：window.__ModuleLoader__.load({ id, factory(require) }) 加载器外壳与
 * ctx.slots.inject 调用形状来自 DSH 官方插件模板
 * （@deepseek-ai/dsh, MIT, Copyright (c) 2026 DeepSeek）。业务逻辑自研。
 * 详见 THIRD-PARTY-NOTICES.md §1
 */
// 早期: 有一条全屏遮罩 .dshpurge-auth-mask（fixed, z-index 10100, pointer-events auto）
// 会吃掉整个页面的点击 —— 侧边栏工作区点不动就是它挡的。
// 这里从我们自己的客户端插件注入一条样式把它压掉（服务端逻辑不受影响，随时可删）。
try {
  if (typeof document !== "undefined" && !document.getElementById("agent-core-unmask")) {
    const st = document.createElement("style");
    st.id = "agent-core-unmask";
    st.textContent = ".dshpurge-auth-mask{display:none !important;pointer-events:none !important}"
      + ".dshpurge-auth-legal{display:none !important}";
    (document.head || document.documentElement).appendChild(st);
  }
} catch {}
/**
 * dsh-agent-core —— 客户端半边（设置 → Agent Core）
 *
 * 刻意做成**极薄的一层**：只注册一个 settings.section，里面直接嵌
 * `/dsh-agent-core/panel` 这个独立页面（同源 iframe）。
 *
 * 为什么不在客户端里重写一遍 UI：
 *   1. 之前那版用 React 写了一大坨，设置里点进去是空白（客户端 bundle 出错时
 *      整块 section 就废了，而且没法在服务端日志里看到）。
 *   2. 独立页面（panel.html）是每次请求现读的，改样式不用重启，也不依赖
 *      客户端打包——出问题只需要看服务器这一层。
 *   3. 放在 iframe 里，用户在设置里点开就是同一套界面，不出现"两份 UI"。
 *
 * 如果 iframe 被什么策略挡了，卡片里还有一个「新窗口打开」的直链兜底。
 */
window.__ModuleLoader__.load({
  id: "dsh-agent-core",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useEffect, useRef, useState } = React;

    const NS = "agent-core";
    const LABEL = "Agent Core";
    const PANEL = "/dsh-agent-core/panel";

    function AgentCoreSection() {
      const boxRef = useRef(null);
      const [height, setHeight] = useState(640);

      // 早期：面板会把自身内容高度 postMessage 上来（切页时高度会变），
      //   这里跟着调 iframe 高度，避免出现"切到长页被截断 / 切回短页留一片空白"。
      useEffect(() => {
        const onMsg = (ev) => {
          const d = ev && ev.data
          if (!d || d.type !== 'agentcore-height') return
          const h = Number(d.h)
          if (Number.isFinite(h) && h > 200) setHeight(Math.min(Math.max(h, 480), 4000))
        }
        window.addEventListener('message', onMsg)
        return () => window.removeEventListener('message', onMsg)
      }, [])

      // 让 iframe 跟着设置页可视高度走（设置页通常是整屏滚动）
      useEffect(() => {
        const calc = () => {
          try {
            const top = boxRef.current ? boxRef.current.getBoundingClientRect().top : 120;
            const h2 = Math.max(480, window.innerHeight - top - 32);
            setHeight(h2);
          } catch {
            setHeight(640);
          }
        };
        calc();
        window.addEventListener("resize", calc);
        return () => window.removeEventListener("resize", calc);
      }, []);

      return h(
        "div",
        { ref: boxRef, style: { display: "flex", flexDirection: "column", gap: 8, minHeight: 480 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
          h("span", { style: { fontSize: 13, fontWeight: 600 } }, "Agent Core"),
          h(
            "a",
            { href: PANEL, target: "_blank", rel: "noreferrer",
              style: { fontSize: 12, color: "var(--dsw-alias-brand-primary, #4f8cff)", textDecoration: "none" } },
            "新窗口打开 ↗"
          )
        ),
        h("iframe", {
          src: PANEL,
          title: "Agent Core",
          style: {
            width: "100%",
            height: height + "px",
            border: "1px solid var(--dsw-alias-border-l2, #252b37)",
            borderRadius: "12px",
            background: "transparent",
          },
        })
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: NS, order: 7, label: () => LABEL },
              AgentCoreSection
            ),
            "agent-core: settings section"
          ),
        "agent-core: settings section"
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.AgentCoreSection = AgentCoreSection;
    return module.exports;
  },
});
