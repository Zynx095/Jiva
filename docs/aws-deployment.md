> **Status (2026-09-26): SYNTHESIZED, NOT DEPLOYED.** `cdk synth` succeeds (EventBridge + 6 rules with SQS DLQ, 8 Lambdas, DynamoDB, Cognito + REST authorizer, WebSocket API with IAM-authorized `$connect`, CloudWatch, S3). Nothing below has been deployed or live-tested. The Lambda processors do not yet include the local engine repairs (ordering watermarks, case-bound acceptance, per-role realtime filtering). See `docs/opus-final-system-status.md`.

# JIVA AWS Deployment Guide

This guide describes how to deploy, manage, and verify JIVA on AWS using the AWS Cloud Development Kit (CDK).

## Prerequisites
1. Node.js >= 18 and npm installed.
2. AWS CLI installed and configured (`aws configure`) or environment variables set:
   ```bash
   export AWS_ACCESS_KEY_ID="AKIA..."
   export AWS_SECRET_ACCESS_KEY="..."
   export AWS_REGION="ap-south-1" # Or us-east-1
   ```
3. Verified Amazon Bedrock model access for `anthropic.claude-3-haiku-20240307-v1:0` in your AWS region.

---

## Deployment Commands

### 1. Check Infrastructure Status
Synthesizes the CloudFormation template and verifies stack constructs without executing any deployment:
```bash
npm run aws:status
```

### 2. Bootstrap AWS Account (One-time)
Initializes the AWS CDK bootstrap stack (S3 bucket, ECR repo, SSM parameters):
```bash
npm run aws:bootstrap
```

### 3. Deploy Stack
Synthesizes and deploys all resources to your AWS account:
```bash
npm run aws:deploy
```
This provisions:
- Amazon EventBridge custom event bus: `jiva-healthcare-mesh`
- Amazon DynamoDB table: `jiva-operational-mesh`
- Amazon Cognito User Pool: `jiva-user-pool`
- 7 Domain Lambda Functions
- Amazon API Gateway REST & WebSocket APIs
- Amazon S3 bucket for audit trails
- Amazon CloudWatch Dashboard & Alarms

### 4. Verify Demo Readiness
Runs the pre-flight verification script across all subsystems:
```bash
npm run demo:check
```

### 5. Run Live AWS Scenario
Executes the flagship Bengaluru emergency coordination simulation against the live AWS infrastructure:
```bash
export API_GATEWAY_URL="https://<api-id>.execute-api.<region>.amazonaws.com/prod"
npm run simulate:aws:blr
```

### 6. Teardown Infrastructure
To safely destroy all provisioned AWS resources after the hackathon:
```bash
npm run aws:destroy -- --force
```
*(Requires explicit `--force` flag to prevent accidental deletion).*
