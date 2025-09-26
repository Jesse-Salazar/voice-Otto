const sheets = require('./googleSheets');

(async () => {
  try {
    const list = await sheets.getProjectsByStatus('Approved');
    if (!list || list.length === 0) {
      console.log('NO_APPROVED');
      process.exit(0);
    }
    console.log(JSON.stringify(list[0], null, 2));
  } catch (e) {
    console.error('ERR', e.message || e);
    process.exit(2);
  }
})();
