import {
  Certificate,
  CertificateValidation,
} from "aws-cdk-lib/aws-certificatemanager";
import {
  CaaAmazonRecord,
  HostedZone,
  type HostedZoneAttributes,
} from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export interface WildcardCertificateProps {
  readonly zone: HostedZoneAttributes;
}

/**
 * One certificate for every domain in the account, `*.<zone>`, validated in the zone. ACM limits a
 * certificate's first name to 64 characters, so one for `<domain>.<zone>` would leave a domain's
 * name as few as 18.
 */
export class WildcardCertificate extends Construct {
  public readonly certificate: Certificate;

  constructor(
    scope: Construct,
    id: string,
    { zone }: WildcardCertificateProps,
  ) {
    super(scope, id);

    const hostedZone = HostedZone.fromHostedZoneAttributes(this, "Zone", zone);

    const caa = new CaaAmazonRecord(this, "Caa", { zone: hostedZone });

    this.certificate = new Certificate(this, "Certificate", {
      domainName: `*.${hostedZone.zoneName}`,
      validation: CertificateValidation.fromDns(hostedZone),
    });

    // ACM checks CAA before it issues.
    this.certificate.node.addDependency(caa);
  }
}
