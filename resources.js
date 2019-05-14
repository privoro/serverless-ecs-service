module.exports = (serverlessService, config, options) => {
  let slsServiceName = serverlessService.service;
  return {
    LogGroup: () => ({
      'LogGroup': {
        Type: 'AWS::Logs::LogGroup',
        Properties: {
          LogGroupName: `${slsServiceName}-ecs-service`
        }
      }
    }),

    Route53CName: () => {
      return {
        CName: {
          Type: "AWS::Route53::RecordSetGroup",
          Properties: {
            HostedZoneName: config.hostedzone.name,
            Comment: "DNS record for ecs service",
            RecordSets: [
              {
                Name: `${slsServiceName}.${config.hostedzone.name}`,
                Type: "CNAME",
                TTL: "60",
                ResourceRecords: [config.alb.dns]
              }
            ]
          }
        }
      }
    },

    EcsService: (containers, tag) => ({
      'ECSService': {
        Type: 'AWS::ECS::Service',
        DependsOn: containers.map(container => `${container.name}TargetGroup`),
        Properties: {
          Cluster: config.cluster,
          LaunchType: 'FARGATE',
          DeploymentConfiguration: {
            MaximumPercent: 200,
            MinimumHealthyPercent: 50
          },
          DesiredCount: config.scale,
          //HealthCheckGracePeriodSeconds: 120,
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              AssignPublicIp: 'ENABLED',
              SecurityGroups: config.vpc['security-groups'] || [],
              Subnets: config.vpc.subnets || []
            }
          },
          SchedulingStrategy: 'REPLICA',
          ServiceName: `${slsServiceName}-${tag}`,
          TaskDefinition: { Ref: 'TaskDefinition' },
          LoadBalancers: containers.map(container => ({
            ContainerName: container.name,
            ContainerPort: container.port,
            TargetGroupArn: {Ref: `${container.name}TargetGroup`}
          }))
        }
      },
    }),

    EcsTaskDefinition: (containers, tag) => {
      let getImageName = (container) => {
        let parts = [container.name];
        if(config.ecr.namespace) {
          parts.unshift(config.ecr.namespace);
        }
        return parts.join('/') + `:${tag}`;
      };

      let getRepoUrl = (container) => {
        let name = getImageName(container);

        return `${config.ecr['aws-account-id']}.dkr.ecr.${options.region}.amazonaws.com/${name}`;
      }

      let containerDefinitions = containers.map(container => ({
        Essential: true,
        Image: getRepoUrl(container),
        Name: container.name,
        Environment: [
          {
            Name: 'BASE_PATH',
            Value: `/${container.path}`.replace('//','/')
          }
        ],
        PortMappings: [
          {
            ContainerPort: container.port
          }
        ],
        ReadonlyRootFilesystem: true,
        LogConfiguration: {
          LogDriver: 'awslogs',
          Options: {
            'awslogs-group': `${slsServiceName}-ecs-service`,
            'awslogs-region': options.region,
            'awslogs-stream-prefix': container.name,
          }
        }
      }));

      return {
        [`TaskDefinition`]: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ExecutionRoleArn: { Ref: 'ECSTaskExecutionRole' },
            Cpu: config.cpu || 1024,
            Memory: config.memory || 2048,
            NetworkMode: 'awsvpc',
            RequiresCompatibilities: ['FARGATE'],
            ContainerDefinitions: containerDefinitions,
            Family: `${slsServiceName}-ecs-service`
          }
        }
      }
    },

    EcsTaskExecutionRole: () => ({
      'ECSTaskExecutionRole': {
        Type: 'AWS::IAM::Role',
        Properties: {
          AssumeRolePolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Principal: {
                  Service: [
                    'ecs-tasks.amazonaws.com'
                  ]
                },
                Action: [
                  'sts:AssumeRole'
                ]
              }
            ]
          },
          Path: "/",
          Policies: [
            {
              PolicyName: `${slsServiceName}TaskExecution`,
              PolicyDocument: {
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: [
                      'ecr:GetAuthorizationToken',
                      'ecr:BatchCheckLayerAvailability',
                      'ecr:GetDownloadUrlForLayer',
                      'ecr:BatchGetImage',
                      'logs:CreateLogStream',
                      'logs:PutLogEvents'
                    ],
                    Resource: '*'
                  }
                ]
              }
            }
          ]
        }
      }
    }),

    TargetGroup: (container, protocol) => {
      return {
        [`${container.name}TargetGroup`]: {
          Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          Properties: {
            HealthCheckIntervalSeconds: 30,
            HealthCheckPath: container.healthcheck.path,
            HealthCheckProtocol: container.healthcheck.protocol,
            HealthCheckPort: container.healthcheck.port,
            HealthyThresholdCount: 5,
            UnhealthyThresholdCount: 5,
            Matcher: {
              HttpCode: container.healthcheck.codes
            },
            Port: 3000,
            Protocol: protocol,
            TargetType: 'ip',
            VpcId: config.vpc.id,
          },
        }
      }
    },

    ListenerRule: (container, priority) => {
      let path =container.path.replace(/\/$/, "");
      path = path.replace(/^\//, "");
      return {
        [`${container.name}ListenerRule`]: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          DependsOn: [
            `${container.name}TargetGroup`
          ],
          Properties: {
            Actions: [
              {
                Type: "forward",
                TargetGroupArn: {Ref: `${container.name}TargetGroup`}
              }
            ],
            Conditions: [
              {
                Field: "path-pattern",
                Values: [
                  `/${path}`.replace('//','/'),
                  `/${path}/*`.replace('//','/')
                ]
              },
              {
                Field: "host-header",
                Values: [
                  `${slsServiceName}.${config.hostedzone.name}`.replace(/\.$/, "")
                ]
              }
            ],
            Priority: priority,
            ListenerArn: config.alb.listener.arn,
          }
        }
      };
    },

    ApiGatewayRestApi: () => ({
      /**
       * EDGE: For an edge-optimized API and its custom domain name.
       * REGIONAL: For a regional API and its custom domain name.
       * PRIVATE: For a private API.
       */
      RestAPI: {
        Type: 'AWS::ApiGateway::RestApi',
        Properties: {
          Description: `API for ${slsServiceName}`,
          Name: slsServiceName,
          EndpointConfiguration: {
            Types: ['EDGE'],
          }
        },
      }
    }),


    ApiGatewayResource: (path, name) => {
      if(path[0] === '/'){ path = path.substr(1); }

      return {
        [`${name}PathResource`]: {
          Type: 'AWS::ApiGateway::Resource',
          Properties: {
            ParentId: `!GetAtt RestAPI.RootResourceId`,
            RestApiId: `!Ref RestAPI`,
            PathPart: path
          }
        }
      };
    },

    ApiGatewayProxyResource: (name, useRoot = false) => {
      let parentId = useRoot ? '!GetAtt RestAPI.RootResourceId'
        : `!Ref ${name}PathResource`;

      return {
        [`${name}ProxyResource`]: {
          Type: 'AWS::ApiGateway::Resource',
          Properties: {
            ParentId: parentId,
            RestApiId: `!Ref RestAPI`,
            PathPart: `{proxy+}`
          }
        }
      }
    },

    ApiGatewayRootMethod: (name) => {
      return {
        [`${name}RootMethod`]: {
          Type: 'AWS::ApiGateway::Method',
          Properties: {
            HttpMethod: 'ANY',
            ResourceId: `!Get Att RestAPI.RootResourceId`,
            AuthorizationType: 'NONE',
            Integration: {
              IntegrationHttpMethod: 'ANY',
              Type: 'HTTP_PROXY',
              Uri: `!GetAtt `
            }
          }
        }
      };
    },

    ApiGatewayPathMethod: () => {
      return {};
    },

    ApiGatewayProxyMethod: () => {
      return {};
    },

    ApiGatewayStage: () => {},
    ApiGatewayBasePathMapping: () => {},


  }
};
