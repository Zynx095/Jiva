#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { JivaAwsStack } from '../lib/aws-stack';

const app = new cdk.App();
new JivaAwsStack(app, 'JivaAwsStack', {
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID || '123456789012', 
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'ap-south-1' 
  },
});
