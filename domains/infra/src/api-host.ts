import {
  DomainName,
  EndpointAccessMode,
  EndpointType,
  type RestApi,
  SecurityPolicy,
} from "aws-cdk-lib/aws-apigateway";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  ARecord,
  HostedZone,
  type HostedZoneAttributes,
  RecordTarget,
} from "aws-cdk-lib/aws-route53";
import { ApiGatewayDomain } from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";

import { domainHost } from "./names.ts";

export interface ApiHostProps {
  readonly domain: string;
  readonly zone: HostedZoneAttributes;
  readonly certificateArn: string;
  readonly api: RestApi;
}

/**
 * The host a domain's API answers at, `<domain>.<zone>`, mapped to the API's stage at its root, and
 * its record in the domain account's zone.
 */
export class ApiHost extends Construct {
  constructor(
    scope: Construct,
    id: string,
    { domain, zone, certificateArn, api }: ApiHostProps,
  ) {
    super(scope, id);

    const hostedZone = HostedZone.fromHostedZoneAttributes(this, "Zone", zone);
    const host = domainHost(domain, hostedZone.zoneName);

    const domainName = new DomainName(this, "DomainName", {
      domainName: host,
      certificate: Certificate.fromCertificateArn(
        this,
        "Certificate",
        certificateArn,
      ),
      endpointType: EndpointType.REGIONAL,
      securityPolicy: SecurityPolicy.TLS13_1_2_PFS_PQ_2025_09,
      endpointAccessMode: EndpointAccessMode.STRICT,
    });

    domainName.addBasePathMapping(api, { stage: api.deploymentStage });

    // Only CloudFront reaches this host, and it does so over IPv4.
    new ARecord(this, "Alias", {
      zone: hostedZone,
      recordName: host,
      target: RecordTarget.fromAlias(new ApiGatewayDomain(domainName)),
    });
  }
}
