let sample = `
  serverless-ecs-service:
    cluster: arn:aws:ecs:us-west-2:492058901556:cluster/serverless-plugin-test
    hostedzone:
      name: dev.privoro.com.
      CertificateArn: arn:aws:acm:us-east-1:492058901556:certificate/12963c0c-226a-4b53-b115-3cba97514edb
    alb:
      arn: arn:aws:elasticloadbalancing:us-west-2:492058901556:loadbalancer/app/serverless-plugin-test/e3dd81d3e5b6f9bc
      dns: serverless-plugin-test-1229887500.us-west-2.elb.amazonaws.com
      listener:
        arn: arn:aws:elasticloadbalancing:us-west-2:492058901556:listener/app/serverless-plugin-test/e3dd81d3e5b6f9bc/ff00a98c9bee6bd9
    vpc:
      id: vpc-837997e5
      subnets: # PUBLIC
        - subnet-fbf6a4b2
        - subnet-0b80bb6c
      security-groups: # FOR LOAD BALANCER (EG PUBLIC)
        - sg-12637469
    cpu: 1024
    memory: 2048
    scale: 1
    ecr:
      aws-account-id: 492058901556 # default to aws credentials account
      namespace: dm # default to stage
    containers:
      - name: demo
        path: bar
        docker-dir: ./ # default to service path
        port: 3000
        healthcheck:
          path: /status # default to /
          port: 3000 # default to 80
          codes: '200-299' # default to 200-299
          protocol: 'HTTP'  
`;

class Config {
  constructor(obj){
    Object.assign(this,obj);
  }

  static validate(obj) {
    // if invalid throw new Error
  }
}

module.exports = {
  ConfigFactory: (cfg) => {
      Config.validate(cfg);
      return new Config(cfg);
  }
};
