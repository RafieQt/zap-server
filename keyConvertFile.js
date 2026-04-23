const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "zapper-admin-SDK.json");

const key = fs.readFileSync(filePath, "utf8");
const base64 = Buffer.from(key).toString("base64");

console.log(base64);