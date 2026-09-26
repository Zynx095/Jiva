import { execSync } from 'child_process';
import path from 'path';

const action = process.argv[2] || 'status';
const cdkDir = path.resolve(__dirname, '../infrastructure/aws');

console.log(`\n============================================================`);
console.log(`                JIVA AWS INFRASTRUCTURE: ${action.toUpperCase()}`);
console.log(`============================================================\n`);

function hasAwsCredentials(): boolean {
  return !!(
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
    process.env.AWS_PROFILE ||
    process.env.AWS_SESSION_TOKEN
  );
}

try {
  switch (action) {
    case 'bootstrap': {
      console.log('[AWS Manage] Checking AWS credentials for CDK bootstrap...');
      if (!hasAwsCredentials()) {
        console.log('ℹ Notice: No AWS credentials detected in environment variables.');
        console.log('  To bootstrap on your AWS account:');
        console.log('    1. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or configure aws configure)');
        console.log('    2. Run: npx cdk bootstrap aws://<ACCOUNT-ID>/<REGION>');
        console.log('  Local development and mock demo modes remain 100% functional without AWS credentials.\n');
        process.exit(0);
      }
      console.log('[AWS Manage] Running CDK bootstrap...');
      execSync('npx cdk bootstrap', { cwd: cdkDir, stdio: 'inherit' });
      break;
    }

    case 'deploy': {
      console.log('[AWS Manage] Deploying JivaAwsStack to AWS...');
      if (!hasAwsCredentials()) {
        console.error('❌ Error: AWS credentials required to deploy live infrastructure.');
        console.log('  Please set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION.\n');
        process.exit(1);
      }
      execSync('npx cdk deploy --require-approval never', { cwd: cdkDir, stdio: 'inherit' });
      break;
    }

    case 'status': {
      console.log('[AWS Manage] Checking infrastructure status and synthesized template...');
      execSync('npx cdk synth --quiet', { cwd: cdkDir, stdio: 'inherit' });
      console.log('\n✓ CloudFormation Stack: JivaAwsStack synthesized and valid.');
      console.log('✓ Target Event Mesh: jiva-healthcare-mesh');
      console.log('✓ Target Dynamo Table: jiva-operational-mesh');
      console.log('✓ Bedrock Target: anthropic.claude-3-haiku-20240307-v1:0');
      console.log('✓ CloudWatch Dashboard: JIVA-Operational-Command-Center\n');
      break;
    }

    case 'destroy': {
      const isForce = process.argv.includes('--force');
      if (!isForce) {
        console.warn('⚠️  DESTRUCTIVE ACTION SAFEGUARD:');
        console.warn('  To destroy the AWS infrastructure, run:');
        console.warn('    npm run aws:destroy -- --force\n');
        process.exit(0);
      }
      console.log('[AWS Manage] Destroying AWS stack...');
      execSync('npx cdk destroy --force', { cwd: cdkDir, stdio: 'inherit' });
      break;
    }

    default:
      console.error(`Unknown action: ${action}`);
      process.exit(1);
  }
} catch (err: any) {
  console.error(`[AWS Manage] Action '${action}' failed:`, err.message || err);
  process.exit(1);
}
