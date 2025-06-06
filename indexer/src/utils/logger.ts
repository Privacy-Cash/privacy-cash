import bunyan from 'bunyan';
import * as AWS from 'aws-sdk';

// Initialize AWS SDK
AWS.config.update({
  region: process.env.AWS_REGION!,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
});

const CloudWatchStream = require('bunyan-aws');
const myStream = new CloudWatchStream({
           logGroupName: 'solana-privacy',
           logStreamName: 'ec2-server1-stream',
           cloudWatchOptions: {
               region: process.env.AWS_REGION,
               sslEnabled: true
           }
       });
       
export const logger = bunyan.createLogger({
    name: 'logger',
    streams: [{
        stream: myStream,
        type: 'raw',
        level: 'info',
    }]
}); 