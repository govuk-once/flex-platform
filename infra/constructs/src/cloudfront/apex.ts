import {
  Certificate,
  CertificateValidation,
} from "aws-cdk-lib/aws-certificatemanager";
import type { IDistribution } from "aws-cdk-lib/aws-cloudfront";
import {
  AaaaRecord,
  ARecord,
  CaaAmazonRecord,
  type IHostedZone,
  RecordTarget,
} from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import type { Construct } from "constructs";

// What a distribution that answers at a zone's apex needs there. Each builds in the scope it is
// given, under the IDs named, and not in a construct of its own: a distribution's construct holds
// these beside the distribution, and their IDs are a contract.

/**
 * A certificate for a zone's apex, as `Certificate`, validated in the zone, with the CAA record
 * that lets only Amazon issue for it, as `Caa`.
 */
export function apexCertificate(
  scope: Construct,
  zone: IHostedZone,
  domainName: string,
): Certificate {
  // ACM checks CAA before it issues, so the record comes first.
  const caa = new CaaAmazonRecord(scope, "Caa", {
    zone,
    recordName: domainName,
  });

  // CloudFormation writes the validation record into the zone and waits for ACM to issue.
  const certificate = new Certificate(scope, "Certificate", {
    domainName,
    validation: CertificateValidation.fromDns(zone),
  });
  certificate.node.addDependency(caa);
  return certificate;
}

/**
 * An alias at the apex for IPv4 and IPv6, as `AliasIpv4` and `AliasIpv6`, since a distribution
 * answers on both.
 */
export function apexAliases(
  scope: Construct,
  zone: IHostedZone,
  recordName: string,
  distribution: IDistribution,
): void {
  const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
  new ARecord(scope, "AliasIpv4", { zone, recordName, target });
  new AaaaRecord(scope, "AliasIpv6", { zone, recordName, target });
}
