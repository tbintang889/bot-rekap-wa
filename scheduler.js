const cron = require('node-cron');
const { exec } = require('child_process');

function jalanCollector() {
  console.log('Scheduler: jalanin WA collector');
  exec('node collector.js tarik', (err, stdout, stderr) => {
    console.log(stdout || 'collector selesai');
  });
}

cron.schedule('0 8 * * *', jalanCollector);
cron.schedule('0 13 * * *', jalanCollector);
cron.schedule('0 20 * * *', jalanCollector);

console.log('Scheduler jalan: 08.00, 13.00, 20.00');
