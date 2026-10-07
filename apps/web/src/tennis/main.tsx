import React from "react";
import ReactDOM from "react-dom/client";
import { TennisApp } from "./TennisApp";
import "@fontsource-variable/noto-sans-sc";
import "../styles.css";
import "./tennis.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TennisApp />
  </React.StrictMode>,
);
