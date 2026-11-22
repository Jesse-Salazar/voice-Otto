const { createAuthority, authorityListener } = require("../../authority-service");

const config = JSON.parse(process.argv[2]);
const authority = createAuthority(config);
const listener = authorityListener(authority);
listener.listen(config.socketPath, () => process.send("ready"));
process.on("message", message => {
  if (message === "stop") listener.close(() => {
    authority.close();
    process.disconnect();
  });
});
