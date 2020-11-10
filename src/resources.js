module.exports = (serverlessService, config, options) => {
  let slsServiceName = serverlessService.service;

  function secretArn(secret) {
    switch(secret.type)  {
      case 'ssm':
        return `arn:aws:ssm:${options.region}:${config.ecr['aws-account-id']}:parameter/${secret.id}`;
      case 'kms':
        return `arn:aws:kms:${options.region}:${config.ecr['aws-account-id']}:key/${secret.id}`;
      case 'secretsmanager':
        return `arn:aws:secretsmanager:${options.region}:${config.ecr['aws-account-id']}:secret:${secret.id}`;
      default:
        console.error(`${secret.type} is not a supported type for secret ${secret.name}`);
        return null;
    }
  }

  let SecretsPolicyStatement = (containers) => {
    return {
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameters",
        "secretsmanager:GetSecretValue",
        "kms:Decrypt"
      ],
      "Resource":
        flattenDeep(containers.map(container => (container.secrets || []).map(secret => secretArn(secret) + '*')))
    }
  };

  let hasSecrets= (containers) => {
    let withSecrets = containers.filter(container => Array.isArray(container.secrets) && container.secrets.length > 0);
    return withSecrets.length > 0;
  }

  function flattenDeep(arr1) {
    return arr1.reduce((acc, val) => Array.isArray(val) ? acc.concat(flattenDeep(val)) : acc.concat(val), []);
  }

  return {
    LogGroup: () => ({
      'LogGroup': {
        Type: 'AWS::Logs::LogGroup',
        Properties: {
          LogGroupName: `${slsServiceName}-ecs-service-${options.stage}`
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
                Name: `${slsServiceName}-lb.${config.hostedzone.name}`,
                Type: "CNAME",
                TTL: "60",
                ResourceRecords: [
                  config.alb.dns
                ]
              }
            ]
          }
        }
      }
    },

    Route53AAlias: () => {
      return {
        ApiDnsEntry: {
          Type: "AWS::Route53::RecordSet",
          DependsOn: [
            "RestAPI"
          ],
          Properties: {
            HostedZoneName: config.hostedzone.name,
            Name: `${slsServiceName}.${config.hostedzone.name}`,
            Type: "A",
            AliasTarget: {
              DNSName: { "Fn::GetAtt": ["CustomDomain", "DistributionDomainName"] },
              HostedZoneId: "Z2FDTNDATAQYW2" // amazon's account cloudfront id
            }
          }
        }
      }
    },

    EcsService: (containers, tag) => ({
      'ECSService': {
        Type: 'AWS::ECS::Service',
        DependsOn: (containers || []).filter(container => !!container.path).map(container => `${container.name}TargetGroup`),
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
          ServiceName: `${slsServiceName}-${options.stage}-${tag}`,
          TaskDefinition: { Ref: 'TaskDefinition' },
          LoadBalancers: containers.filter(container => !! container.path).map(container => ({
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
        return (parts.join('/') + `:${tag}`).toLowerCase();
      };

      let getRepoUrl = (container) => {
        let name = getImageName(container);

        return `${config.ecr['aws-account-id']}.dkr.ecr.${options.region}.amazonaws.com/${name}`;
      };

      let containerDefinitions = containers.map(container => {
        let env = Object.keys(serverlessService.provider.environment)
          // exclude env vars overridden in container env config
          .filter(key => {
            Object.keys(container.environment || {}).indexOf(key) === -1
          })
          .map(key => ({
            Name: key,
            Value: serverlessService.provider.environment[key]
          }));
        env = env.concat( Object.keys(container.environment || {}).map(key => ({
          Name: key,
          Value: container.environment[key]
        })));

        env.push({
          Name: 'BASE_PATH',
          Value: `/${container.path}`.replace('//','/')
        });
        let secrets = (container.secrets||[]).map(secret => ({
            Name: secret.name,
            ValueFrom: secretArn(secret)
          }));
        return {
          Essential: true,
          Image: getRepoUrl(container),
          Name: container.name,
          Cpu: parseInt(Math.floor((config.cpu || 1024)/containers.length)),
          Environment: env,
          Secrets: secrets,
          PortMappings: !container.port ? [] : [
            {
              ContainerPort: container.port
            }
          ],
          ReadonlyRootFilesystem: true,
          LogConfiguration: {
            LogDriver: 'awslogs',
            Options: {
              'awslogs-group': `${slsServiceName}-ecs-service-${options.stage}`,
              'awslogs-region': options.region,
              'awslogs-stream-prefix': container.name,
            }
          }
        }
      });

      return {
        [`TaskDefinition`]: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ExecutionRoleArn: { Ref: 'ECSTaskExecutionRole' },
            TaskRoleArn: { Ref: 'ECSTaskRole' },
            Cpu: config.cpu || 1024,
            Memory: config.memory || 2048,
            NetworkMode: 'awsvpc',
            RequiresCompatibilities: ['FARGATE'],
            ContainerDefinitions: containerDefinitions,
            Family: `${slsServiceName}-ecs-service-${options.stage}`
          }
        }
      }
    },

    EcsTaskExecutionRole: (containers) => ({
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
                  },
                  hasSecrets(containers) ? SecretsPolicyStatement(containers) : null
                ].filter(statement => statement !== null)
              }
            }
          ]
        }
      }
    }),

    EcsTaskRole: (containers) => ({
      'ECSTaskRole': {
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
              PolicyName: `${slsServiceName}TaskRole`,
              PolicyDocument: {
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: [
                      'sns:Publish',
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
                  `${slsServiceName}.${config.hostedzone.name}`.replace(/\.$/, ""),
                  `${slsServiceName}-lb.${config.hostedzone.name}`.replace(/\.$/, "")
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
          Description: `API for ${slsServiceName} `,
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
            ParentId: { "Fn::GetAtt" : [ "RestAPI", "RootResourceId" ] },
            RestApiId: {Ref: `RestAPI`},
            PathPart: path
          }
        }
      };
    },

    ApiGatewayProxyResource: (name, useRoot = false) => {
      let parentId = useRoot ?
        { "Fn::GetAtt" : [ "RestAPI", "RootResourceId" ] }
        : {Ref: `${name}PathResource`};

      return {
        [`${name}ProxyResource`]: {
          Type: 'AWS::ApiGateway::Resource',
          Properties: {
            ParentId: parentId,
            RestApiId: {Ref: 'RestAPI'},
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
            ResourceId: { "Fn::GetAtt" : [ "RestAPI", "RootResourceId" ] },
            AuthorizationType: 'NONE',
            Integration: {
              IntegrationHttpMethod: 'ANY',
              Type: 'HTTP_PROXY',
              //Uri: `https://${config.alb.dns}`
              Uri: `https://${slsServiceName}-lb.${config.hostedzone.name}`.replace(/\.$/, "")
            },
            RestApiId: {Ref: 'RestAPI'}
          }
        }
      };
    },

    ApiGatewayPathMethod: (name, path, useRoot) => {
      return {
        [`${name}PathMethod`]: {
          Type: 'AWS::ApiGateway::Method',
          Properties: {
            HttpMethod: 'ANY',
            ResourceId: useRoot ?
              { "Fn::GetAtt" : [ "RestAPI", "RootResourceId" ] }
              : {Ref: `${name}PathResource`},
            AuthorizationType: 'NONE',
            Integration: {
              IntegrationHttpMethod: 'ANY',
              Type: 'HTTP_PROXY',
              //Uri: `https://${config.alb.dns}`
              Uri: `https://${slsServiceName}-lb.${config.hostedzone.name}`.replace(/\.$/, "") + `/${path}`,
            },
            RestApiId: {Ref: 'RestAPI'}
          }
        }
      };
    },

    ApiGatewayProxyMethod: (name, path, useRoot = true) => {
      return {
        [`${name}ProxyMethod`]: {
          Type: 'AWS::ApiGateway::Method',
          Properties: {
            HttpMethod: 'ANY',
            AuthorizationType: 'NONE',
            RequestParameters: {
              "method.request.path.proxy": true
            },
            ResourceId: useRoot ?
              { "Fn::GetAtt" : [ "RestAPI", "RootResourceId" ] }
              : {Ref: `${name}ProxyResource`},
            RestApiId: {Ref: 'RestAPI'},
            Integration: {
              IntegrationHttpMethod: 'ANY',
              Type: 'HTTP_PROXY',
              //Uri: `https://${config.alb.dns}`,
              Uri: `https://${slsServiceName}-lb.${config.hostedzone.name}`.replace(/\.$/, "") + `/${path}/{proxy}`,
              CacheKeyParameters: [
                'method.request.path.proxy'
              ],
              RequestParameters: {
                "integration.request.path.proxy": 'method.request.path.proxy'
              },
              PassthroughBehavior: "WHEN_NO_MATCH"
            }
          }
        }
      };
    },

    ApiGatewayStage: (containers, methods) => {
      return {
        [`Stage${new Date().getTime()}`]: {
          Type: "AWS::ApiGateway::Deployment",
          DependsOn: methods,
          Properties: {
            Description: `${slsServiceName} stage ${options.stage}`,
            RestApiId: {Ref: 'RestAPI'},
            StageName: `${options.stage}`
          }
        }
      }
    },

    ApiGatewayCustomDomain: () => {
      return {
        CustomDomain: {
          Type: "AWS::ApiGateway::DomainName",
          Properties: {
            CertificateArn: config.hostedzone.CertificateArn,
            DomainName: `${slsServiceName}.${config.hostedzone.name}`.replace(/\.$/, ""),
          }
        }
      }
    },

    ApiGatewayBasePathMapping: () => {
      return {
        BasePathMapping: {
          Type: "AWS::ApiGateway::BasePathMapping",
          Properties: {
//            BasePath: "", // cant be empty string
            DomainName: {Ref: "CustomDomain"},
            RestApiId: {Ref: 'RestAPI'},
            Stage: `${options.stage}`
          }
        }
      }
    },



  }
};
