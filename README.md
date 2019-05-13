# Serverless ECS Service
Enables you to deploy docker images to (a preconfigured) ECS Cluster.

# Prerequisite setup
- Existing VPC
- Existing (fargate) ECS cluster to host services.
- Existing Application LoadBalancer 
  - HTTPS listener
- Existing CNAME record for loadbalancer that satisfies ALB certificate
- Existing HOSTED Zone for subdomains created for ecs service

#TODO Demo Cleanup
- CNAME: sls-plugin-demo.dev.privoro.com.
- ALB: arn:aws:elasticloadbalancing:us-west-2:492058901556:loadbalancer/app/serverless-plugin-test/e3dd81d3e5b6f9bc
- ECS: serverless-plugin-test
