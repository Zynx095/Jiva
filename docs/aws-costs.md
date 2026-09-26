# JIVA AWS Cost Considerations & Hackathon Controls

JIVA is engineered with strict, cost-conscious defaults designed to maximize performance while minimizing cloud spending during development and hackathon demonstrations.

## Architecture Cost Controls

| Service | Design Strategy | Monthly Estimate (Hackathon Scale) |
| :--- | :--- | :--- |
| **AWS Lambda** | ARM64 architecture, 128-512MB RAM, scale-to-zero. No idle cost. | < \$0.20 |
| **Amazon DynamoDB** | On-Demand (Pay-Per-Request) billing mode. Auto-expiring TTL on transient items. No provisioned capacity fees. | < \$0.10 |
| **Amazon EventBridge** | Pay per million custom events. Zero idle cost. | < \$0.05 |
| **Amazon API Gateway** | Pay per million HTTP/WebSocket requests. No fixed hourly fee. | < \$0.50 |
| **Amazon Cognito** | First 50,000 MAUs are free under the AWS Free Tier. | \$0.00 |
| **Amazon CloudWatch** | Standard metrics, 1 custom dashboard, alarms limited to critical failures. | < \$0.50 |
| **Amazon S3** | Standard storage with 7-day lifecycle rule for demo audit snapshots. | < \$0.05 |
| **Amazon Bedrock** | Claude 3 Haiku selected over Opus/Sonnet. In-memory `CachedAIProvider` prevents redundant calls. | ~ \$0.50 - \$2.00 |

**Total Estimated Hackathon Cost**: **< \$5.00 USD / month**.

---

## Anti-Patterns Strictly Avoided
1. **No Always-on NAT Gateways**: Lambdas run serverless without mandatory private VPC NAT gateways (\$32/month saved per AZ).
2. **No Kubernetes / EKS Clusters**: Zero base cluster charges (\$73/month saved).
3. **No Kafka / MSK**: Replaced with managed EventBridge.
4. **No Continuous Bedrock Polling**: Bedrock is an asynchronous sidecar triggered strictly on discrete events (`ACCEPTED`, `UNAVAILABLE`).
5. **Deduplication & Caching**: The `CachedAIProvider` caches model responses based on input hash, preventing duplicated API calls during repeated simulation runs.
