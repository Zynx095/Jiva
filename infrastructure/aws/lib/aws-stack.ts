import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { WebSocketIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export class JivaAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ----------------------------------------------------
    // 1. EVENTBRIDGE: Healthcare Event Mesh
    // ----------------------------------------------------
    const jivaEventBus = new events.EventBus(this, 'JivaEventBus', {
      eventBusName: 'jiva-healthcare-mesh',
    });

    // ----------------------------------------------------
    // 2. DYNAMODB: Single-Table Architecture & Audit Ledger
    // ----------------------------------------------------
    const operationalTable = new dynamodb.Table(this, 'JivaOperationalTable', {
      tableName: 'jiva-operational-mesh',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Safe for hackathon tear-down
    });

    // GSI1: Queryable Event Audit Trail across all entities by time
    operationalTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ----------------------------------------------------
    // 3. S3: Audit Reports & Snapshots
    // ----------------------------------------------------
    const auditBucket = new s3.Bucket(this, 'JivaAuditBucket', {
      bucketName: `jiva-audit-reports-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ----------------------------------------------------
    // 4. COGNITO: Role-Based Identity
    // ----------------------------------------------------
    const userPool = new cognito.UserPool(this, 'JivaUserPool', {
      userPoolName: 'jiva-user-pool',
      selfSignUpEnabled: false,
      signInAliases: { email: true, username: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      customAttributes: {
        hospitalId: new cognito.StringAttribute({ mutable: true }),
        ambulanceId: new cognito.StringAttribute({ mutable: true }),
        caseId: new cognito.StringAttribute({ mutable: true }),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'JivaWebClient', {
      userPool,
      userPoolClientName: 'jiva-web-client',
      authFlows: { userPassword: true, userSrp: true },
    });

    // Roles as User Pool Groups
    const roles = ['ADMIN', 'MANAGEMENT', 'HOSPITAL', 'AMBULANCE', 'PATIENT'];
    roles.forEach((roleName) => {
      new cognito.CfnUserPoolGroup(this, `Group-${roleName}`, {
        userPoolId: userPool.userPoolId,
        groupName: roleName,
        description: `JIVA ${roleName} authorization group`,
      });
    });

    // ----------------------------------------------------
    // 5. LAMBDAS: Domain Event Processors
    // ----------------------------------------------------
    const lambdaDir = path.resolve(__dirname, '../../../services/api/dist/lambdas');

    // Common environment variables
    const commonEnv = {
      DYNAMO_TABLE_NAME: operationalTable.tableName,
      EVENT_BUS_NAME: jivaEventBus.eventBusName,
      S3_BUCKET_NAME: auditBucket.bucketName,
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      USE_BEDROCK: 'true',
      BEDROCK_MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0',
    };

    // 5.1 Event Ingestion Lambda
    const ingestionLambda = new lambda.Function(this, 'EventIngestionFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'ingestion.handler',
      code: lambda.Code.fromAsset(lambdaDir),
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10),
    });
    jivaEventBus.grantPutEventsTo(ingestionLambda);

    // 5.2 Emergency Processor Lambda
    const emergencyProcessorLambda = new lambda.Function(this, 'EmergencyProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'emergencyProcessor.handler',
      code: lambda.Code.fromAsset(lambdaDir),
      environment: commonEnv,
      timeout: cdk.Duration.seconds(30),
    });
    operationalTable.grantReadWriteData(emergencyProcessorLambda);
    jivaEventBus.grantPutEventsTo(emergencyProcessorLambda);

    // 5.3 Hospital Acceptance Processor Lambda
    const hospitalProcessorLambda = new lambda.Function(this, 'HospitalProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'hospitalAcceptanceProcessor.handler',
      code: lambda.Code.fromAsset(lambdaDir),
      environment: commonEnv,
      timeout: cdk.Duration.seconds(30),
    });
    operationalTable.grantReadWriteData(hospitalProcessorLambda);
    jivaEventBus.grantPutEventsTo(hospitalProcessorLambda);

    // 5.4 Ambulance Processor Lambda
    const ambulanceProcessorLambda = new lambda.Function(this, 'AmbulanceProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'ambulanceProcessor.handler',
      code: lambda.Code.fromAsset(lambdaDir),
      environment: commonEnv,
      timeout: cdk.Duration.seconds(15),
    });
    operationalTable.grantReadWriteData(ambulanceProcessorLambda);

    // 5.5 Routing Processor Lambda
    const routingProcessorLambda = new lambda.Function(this, 'RoutingProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'routingProcessor.handler',
      code: lambda.Code.fromAsset(lambdaDir),
      environment: commonEnv,
      timeout: cdk.Duration.seconds(20),
    });
    operationalTable.grantReadWriteData(routingProcessorLambda);
    routingProcessorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    // 5.6 Bedrock AI Processor Lambda (Asynchronous Sidecar)
    const aiProcessorLambda = new lambda.Function(this, 'AiProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'aiProcessor.handler',
      code: lambda.Code.fromAsset(lambdaDir),
      environment: commonEnv,
      timeout: cdk.Duration.seconds(60),
    });
    operationalTable.grantReadWriteData(aiProcessorLambda);
    jivaEventBus.grantPutEventsTo(aiProcessorLambda);
    aiProcessorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`,
      ],
    }));
    aiProcessorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    // 5.7 WebSocket Handler Lambda
    const webSocketLambda = new lambda.Function(this, 'WebSocketHandlerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'websocketHandler.handler',
      code: lambda.Code.fromAsset(lambdaDir),
      environment: commonEnv,
      timeout: cdk.Duration.seconds(10),
    });
    operationalTable.grantReadWriteData(webSocketLambda);

    // ----------------------------------------------------
    // 6. EVENTBRIDGE RULES: Routing Event Classes to Lambdas
    //    Every target retries twice, then lands in a dead-letter queue.
    // ----------------------------------------------------
    const eventsDlq = new sqs.Queue(this, 'JivaEventTargetsDlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const lambdaTarget = (fn: lambda.IFunction) => new targets.LambdaFunction(fn, {
      deadLetterQueue: eventsDlq,
      retryAttempts: 2,
      maxEventAge: cdk.Duration.hours(2),
    });
    new events.Rule(this, 'EmergencyEventsRule', {
      eventBus: jivaEventBus,
      eventPattern: {
        source: ['jiva.healthcare'],
        detailType: ['patient.emergency.created', 'care.requirement.created'],
      },
      targets: [lambdaTarget(emergencyProcessorLambda)],
    });

    new events.Rule(this, 'HospitalEventsRule', {
      eventBus: jivaEventBus,
      eventPattern: {
        source: ['jiva.healthcare'],
        detailType: [
          'hospital.acceptance.requested',
          'hospital.acceptance.received',
          'hospital.capacity.updated',
          'hospital.acceptance.expired',
        ],
      },
      targets: [lambdaTarget(hospitalProcessorLambda)],
    });

    new events.Rule(this, 'AmbulanceEventsRule', {
      eventBus: jivaEventBus,
      eventPattern: {
        source: ['jiva.healthcare'],
        detailType: ['ambulance.dispatched', 'ambulance.location.updated'],
      },
      targets: [lambdaTarget(ambulanceProcessorLambda)],
    });

    new events.Rule(this, 'RoutingEventsRule', {
      eventBus: jivaEventBus,
      eventPattern: {
        source: ['jiva.healthcare'],
        detailType: ['destination.changed', 'route.calculated', 'route.recalculated'],
      },
      targets: [lambdaTarget(routingProcessorLambda)],
    });

    new events.Rule(this, 'AiSidecarEventsRule', {
      eventBus: jivaEventBus,
      eventPattern: {
        source: ['jiva.healthcare'],
        detailType: [
          'hospital.acceptance.received',
          'destination.changed',
          'route.calculated',
        ],
      },
      targets: [lambdaTarget(aiProcessorLambda)],
    });

    new events.Rule(this, 'RealtimeBroadcastRule', {
      eventBus: jivaEventBus,
      eventPattern: {
        source: ['jiva.healthcare'],
      },
      targets: [lambdaTarget(webSocketLambda)],
    });

    // ----------------------------------------------------
    // 7. API GATEWAY: REST API & Endpoints
    // ----------------------------------------------------
    const allowedOrigins: string[] = this.node.tryGetContext('allowedOrigins') || ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', 'http://localhost:5176'];
    const api = new apigateway.RestApi(this, 'JivaRestApi', {
      restApiName: 'Jiva Healthcare Platform API',
      description: 'API Gateway for JIVA emergency healthcare coordination',
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Cognito-authenticated ingestion: unauthenticated requests are rejected by API Gateway.
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'JivaCognitoAuthorizer', {
      cognitoUserPools: [userPool],
    });

    // /api/events
    const apiResource = api.root.addResource('api');
    const eventsResource = apiResource.addResource('events');
    eventsResource.addMethod('POST', new apigateway.LambdaIntegration(ingestionLambda), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // ----------------------------------------------------
    // 7b. API GATEWAY WEBSOCKET: realtime fan-out
    //     $connect requires IAM (SigV4) auth. The broadcast Lambda does not yet apply
    //     per-role event filtering, so the socket is deliberately NOT open to anonymous
    //     browsers. A Cognito-token Lambda authorizer + filtering is the next step.
    // ----------------------------------------------------
    const wsIntegration = new WebSocketLambdaIntegration('WsHandlerIntegration', webSocketLambda);
    const webSocketApi = new apigwv2.WebSocketApi(this, 'JivaWebSocketApi', {
      apiName: 'jiva-realtime',
      connectRouteOptions: { integration: wsIntegration, authorizer: new WebSocketIamAuthorizer() },
      disconnectRouteOptions: { integration: wsIntegration },
      defaultRouteOptions: { integration: wsIntegration },
    });
    const wsStage = new apigwv2.WebSocketStage(this, 'JivaWebSocketStage', {
      webSocketApi,
      stageName: 'prod',
      autoDeploy: true,
    });
    webSocketApi.grantManageConnections(webSocketLambda);
    // Built from the API id (not the stage) to avoid a Lambda <-> stage dependency cycle.
    webSocketLambda.addEnvironment('WEBSOCKET_ENDPOINT', `https://${webSocketApi.apiId}.execute-api.${this.region}.amazonaws.com/prod`);

    // ----------------------------------------------------
    // 8. CLOUDWATCH: Dashboards & Alarms
    // ----------------------------------------------------
    const metricNamespace = 'JIVA/HealthcareMesh';

    const eventsProcessedMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: 'JIVA_EVENTS_PROCESSED',
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const eventsFailedMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: 'JIVA_EVENTS_FAILED',
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const acceptanceLatencyMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: 'HOSPITAL_ACCEPTANCE_LATENCY',
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    const routeLatencyMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: 'ROUTE_CALCULATION_LATENCY',
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    const aiRequestsMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: 'AI_REQUESTS',
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const aiFailuresMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: 'AI_FAILURES',
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const dashboard = new cloudwatch.Dashboard(this, 'JivaDashboard', {
      dashboardName: 'JIVA-Operational-Command-Center',
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'JIVA Event Throughput & Failures',
        left: [eventsProcessedMetric],
        right: [eventsFailedMetric],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Coordination Latency (Maps & Acceptance)',
        left: [acceptanceLatencyMetric, routeLatencyMetric],
        width: 12,
      })
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Bedrock AI Invocations & Errors',
        left: [aiRequestsMetric],
        right: [aiFailuresMetric],
        width: 12,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Active Emergency Metrics Summary',
        metrics: [eventsProcessedMetric, aiRequestsMetric, aiFailuresMetric],
        width: 12,
      })
    );

    // Alarms
    new cloudwatch.Alarm(this, 'HighFailedEventsAlarm', {
      metric: eventsFailedMetric,
      threshold: 5,
      evaluationPeriods: 1,
      alarmDescription: 'Triggered when more than 5 events fail in 1 minute.',
    });

    new cloudwatch.Alarm(this, 'HighAiFailuresAlarm', {
      metric: aiFailuresMetric,
      threshold: 3,
      evaluationPeriods: 1,
      alarmDescription: 'Triggered when Bedrock calls fail repeatedly.',
    });

    // ----------------------------------------------------
    // 9. OUTPUTS
    // ----------------------------------------------------
    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: wsStage.url,
      description: 'API Gateway WebSocket URL (IAM-authorized $connect)',
    });

    new cdk.CfnOutput(this, 'EventTargetsDlqUrl', {
      value: eventsDlq.queueUrl,
      description: 'Dead-letter queue for failed EventBridge -> Lambda deliveries',
    });

    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url,
      description: 'Base URL for JIVA REST API Gateway',
      exportName: 'JivaApiUrl',
    });

    new cdk.CfnOutput(this, 'EventBusArn', {
      value: jivaEventBus.eventBusArn,
      description: 'ARN of the JIVA EventBridge Mesh',
      exportName: 'JivaEventBusArn',
    });

    new cdk.CfnOutput(this, 'DynamoTableName', {
      value: operationalTable.tableName,
      description: 'DynamoDB Single-Table Name',
      exportName: 'JivaDynamoTableName',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: 'JivaUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito Web Client ID',
      exportName: 'JivaUserPoolClientId',
    });

    new cdk.CfnOutput(this, 'AuditBucketName', {
      value: auditBucket.bucketName,
      description: 'S3 Audit Reports Bucket Name',
      exportName: 'JivaAuditBucketName',
    });

    new cdk.CfnOutput(this, 'CloudWatchDashboardName', {
      value: dashboard.dashboardName,
      description: 'CloudWatch Dashboard Name',
      exportName: 'JivaDashboardName',
    });
  }
}
