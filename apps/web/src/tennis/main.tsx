import React from "react";
import ReactDOM from "react-dom/client";
import { TennisApp } from "./TennisApp";
import "../styles.css";
import "./tennis.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TennisApp />
  </React.StrictMode>,
);
