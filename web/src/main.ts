import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import "./globals.css";

createApp(App).use(createPinia()).mount("#app");
