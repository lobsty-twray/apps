const express = require("express");
const path = require("path");
const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.use(express.static(path.join(__dirname, "shared")));

app.listen(3000, () => console.log("Shared assets serving on :3000"));
