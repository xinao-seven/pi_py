// 前端入口：创建 Vue 应用，挂载 Pinia 状态管理与根组件 App。
import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import "./globals.css";

createApp(App).use(createPinia()).mount("#app");
