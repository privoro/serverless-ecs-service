class Config {
  constructor(obj){
    Object.assign(this,obj);
  }

  static validate(obj) {
    // if invalid throw new Error
  }
}

module.exports = {
  ConfigFactory: (config) => {
    // backwards compat, merge config.deployment (new structure) to top level (old structure)
    let cfg = Object.assign({},  config.deployment || {}, config);
    let hz = cfg.HostedZone || {};
    let alb = cfg.Alb || {};
    let vpc = cfg.Vpc || {};
    let ecr = cfg.Ecr || {};

    let merged = {
      Cluster: cfg.Cluster,
      HostedZone: { Name: hz.Name, CertificateArn: hz.CertificateArn },
      Alb: {
        Arn: alb.Arn,
        Dns: alb.Dns,
        Listener: {
          Arn: alb.Listener ? alb.Listener.Arn : null
        }
      },
      Vpc: {
        Id: vpc.Id,
        Subnets: vpc.Subnets || [],
        SecurityGroups: vpc.SecurityGroups || [],
      },
      Cpu: 1024,
      Memory: 2048,
      Scale: 1,
      Ecr: {
        AwsAccountId: ecr.AwsAccountId,
        Namespace: ecr.Namespace,
      },
      Containers: (cfg.Containers || []).map(container => {
        let healthcheck = container.HealthCheck || {};
        return {
          Name: container.Name,
          Path: container.Path || "/",
          DockerDir: container.DockerDir || "./",
          Port: container.Port || 80,
          HealthCheck: {
            Path: healthcheck.Path || "/",
            Port: healthcheck.Port || 80,
            Codes: healthcheck.Codes || '200-299',
            Protocol: healthcheck.Protocol || 'HTTP'
          }
        }})
    };

    // TODO use merged
    Config.validate(cfg);
    return new Config(cfg);
  }
};
